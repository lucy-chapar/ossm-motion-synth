// SPDX-License-Identifier: MPL-2.0
// Thin local 1DOF ABI. Upstream Ruckig is unmodified and MIT licensed.
#include <cmath>
#include <ruckig/ruckig.hpp>

using ruckig::ControlInterface;
using ruckig::InputParameter;
using ruckig::OutputParameter;
using ruckig::Result;
using ruckig::Ruckig;
using ruckig::Trajectory;

struct Plan {
    Trajectory<1> trajectory;
    double metadata[5] {};
    double sample[4] {};
    bool valid {false};
};

struct Planner {
    Ruckig<1> otg;
    InputParameter<1> input;
    OutputParameter<1> output;
    double state[8] {};
    explicit Planner(double cycle_time): otg(cycle_time) {}
};

static bool configure(InputParameter<1>& input,
                      double q, double v, double a,
                      double target_q, double target_v, double target_a,
                      double vmax, double amax, double jmax,
                      double minimum_duration, bool velocity_control) {
    const double values[] {q, v, a, target_q, target_v, target_a,
                           vmax, amax, jmax, minimum_duration};
    for (double value: values) {
        if (!std::isfinite(value)) return false;
    }
    if (vmax <= 0 || amax <= 0 || jmax <= 0 || minimum_duration < 0) return false;
    input.current_position[0] = q;
    input.current_velocity[0] = v;
    input.current_acceleration[0] = a;
    input.target_position[0] = target_q;
    input.target_velocity[0] = target_v;
    input.target_acceleration[0] = target_a;
    input.max_velocity[0] = vmax;
    input.max_acceleration[0] = amax;
    input.max_jerk[0] = jmax;
    input.control_interface = velocity_control ? ControlInterface::Velocity : ControlInterface::Position;
    // Even with one DoF, Time is needed to honor minimum_duration. None lets
    // sampling extend beyond a faster independent profile with terminal v/a.
    input.synchronization = ruckig::Synchronization::Time;
    if (minimum_duration > 0) input.minimum_duration = minimum_duration;
    else input.minimum_duration.reset();
    return true;
}

// Ruckig 0.15.3's convenience extrema omit roots in constant-acceleration
// segments and use an unset position target for velocity-control profiles.
// Read the unmodified Community profiles and solve v(t)=0 analytically in
// every segment. No sampled approximation or motion-profile change is used.
static ruckig::Bound position_bounds(const Trajectory<1>& trajectory) {
    double q, v, a;
    trajectory.at_time(0.0, q, v, a);
    ruckig::Bound bounds {q, q, 0.0, 0.0};
    const double duration = trajectory.get_duration();
    const auto consider = [&bounds](double position, double time) {
        if (position < bounds.min) { bounds.min = position; bounds.t_min = time; }
        if (position > bounds.max) { bounds.max = position; bounds.t_max = time; }
    };
    const auto segment = [&](double start, double length, double p, double velocity,
                             double acceleration, double jerk) {
        length = std::min(length, duration - start);
        if (length <= 0.0) return;
        const auto evaluate = [&](double time) {
            if (time < 0.0 || time > length || !std::isfinite(time)) return;
            consider(std::get<0>(ruckig::integrate(time, p, velocity, acceleration, jerk)), start + time);
        };
        evaluate(0.0);
        evaluate(length);
        if (jerk == 0.0) {
            if (acceleration != 0.0) evaluate(-velocity / acceleration);
        } else {
            const double discriminant = acceleration * acceleration - 2.0 * jerk * velocity;
            if (discriminant >= 0.0) {
                const double square_root = std::sqrt(discriminant);
                const double numerator = -acceleration - std::copysign(square_root, acceleration);
                if (numerator == 0.0) evaluate(-acceleration / jerk);
                else {
                    evaluate(numerator / jerk);
                    evaluate(2.0 * velocity / numerator);
                }
            }
        }
    };
    const auto profile = trajectory.get_profiles()[0][0];
    double time = 0.0;
    if (profile.brake.duration > 0.0) {
        for (size_t index = 0; index < 2; ++index) {
            if (profile.brake.t[index] > 0.0) {
                segment(time, profile.brake.t[index], profile.brake.p[index], profile.brake.v[index],
                        profile.brake.a[index], profile.brake.j[index]);
                time += profile.brake.t[index];
            }
        }
    }
    for (size_t index = 0; index < 7; ++index) {
        if (profile.t[index] > 0.0) {
            segment(time, profile.t[index], profile.p[index], profile.v[index], profile.a[index], profile.j[index]);
            time += profile.t[index];
        }
    }
    if (time < duration) segment(time, duration - time, profile.p.back(), profile.v.back(), profile.a.back(), 0.0);
    trajectory.at_time(duration, q, v, a);
    consider(q, duration);
    return bounds;
}

extern "C" {

Planner* ruckig_create_planner(double cycle_time) {
    if (!std::isfinite(cycle_time) || cycle_time <= 0) return nullptr;
    return new Planner(cycle_time);
}

void ruckig_destroy_planner(Planner* planner) { delete planner; }
Plan* ruckig_create_plan() { return new Plan; }
void ruckig_destroy_plan(Plan* plan) { delete plan; }

Plan* ruckig_copy_plan(const Plan* plan) {
    if (!plan->valid) return nullptr;
    return new Plan(*plan);
}

int ruckig_calculate(Planner* planner, Plan* plan,
                     double q, double v, double a,
                     double target_q, double target_v, double target_a,
                     double vmax, double amax, double jmax,
                     double minimum_duration, int velocity_control) {
    plan->valid = false;
    InputParameter<1> input;
    if (!configure(input, q, v, a, target_q, target_v, target_a,
                   vmax, amax, jmax, minimum_duration, velocity_control != 0)) {
        return static_cast<int>(Result::ErrorInvalidInput);
    }
    const auto result = planner->otg.calculate(input, plan->trajectory);
    if (result != Result::Working && result != Result::Finished) return static_cast<int>(result);
    const auto bounds = position_bounds(plan->trajectory);
    plan->metadata[0] = plan->trajectory.get_duration();
    plan->metadata[1] = bounds.min;
    plan->metadata[2] = bounds.max;
    plan->metadata[3] = bounds.t_min;
    plan->metadata[4] = bounds.t_max;
    plan->valid = true;
    return static_cast<int>(result);
}

double* ruckig_plan_metadata(Plan* plan) { return plan->valid ? plan->metadata : nullptr; }

double* ruckig_sample(Plan* plan, double time) {
    if (!plan->valid || !std::isfinite(time) || time < 0 || time > plan->metadata[0]) return nullptr;
    size_t section = 0;
    plan->trajectory.at_time(time, plan->sample[0], plan->sample[1],
                             plan->sample[2], plan->sample[3], section);
    return plan->sample;
}

int ruckig_reset(Planner* planner, double q, double v, double a) {
    if (!std::isfinite(q) || !std::isfinite(v) || !std::isfinite(a)) return -100;
    planner->input.current_position[0] = q;
    planner->input.current_velocity[0] = v;
    planner->input.current_acceleration[0] = a;
    planner->otg.reset();
    planner->output = OutputParameter<1>();
    return 0;
}

int ruckig_update(Planner* planner, double target_q, double target_v, double target_a,
                  double vmax, double amax, double jmax, double minimum_duration) {
    if (!configure(planner->input,
                   planner->input.current_position[0], planner->input.current_velocity[0],
                   planner->input.current_acceleration[0], target_q, target_v, target_a,
                   vmax, amax, jmax, minimum_duration, false)) return -100;
    const auto result = planner->otg.update(planner->input, planner->output);
    if (result != Result::Working && result != Result::Finished) return static_cast<int>(result);
    const auto& output = planner->output;
    planner->state[0] = output.new_position[0];
    planner->state[1] = output.new_velocity[0];
    planner->state[2] = output.new_acceleration[0];
    planner->state[3] = output.new_jerk[0];
    planner->state[4] = output.time;
    planner->state[5] = output.trajectory.get_duration();
    planner->state[6] = output.new_calculation ? 1.0 : 0.0;
    planner->state[7] = static_cast<double>(result);
    // Carry all three derivatives into the next update, including retargeting.
    output.pass_to_input(planner->input);
    return static_cast<int>(result);
}

double* ruckig_state(Planner* planner) { return planner->state; }

}
