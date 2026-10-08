using System.Diagnostics;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Qsys.Motion.Tests;

// MSTest drives the production JavaScript through Node. There is no duplicate C# algorithm.
[TestClass]
public sealed class MotionTests
{
    [TestMethod]
    [DataRow("turning_in_place_does_not_add_distance", DisplayName = "Rotation adds zero metres")]
    [DataRow("stand_rotate_360_has_zero_translation", DisplayName = "Standing 360 degrees")]
    [DataRow("walk_turn_return_preserves_accumulated_distance", DisplayName = "Walk, turn, return")]
    [DataRow("portrait_and_landscape_start_at_zero_heading", DisplayName = "Screen orientation independent start")]
    [DataRow("isolated_shake_is_not_a_step", DisplayName = "Isolated shake")]
    [DataRow("put_on_table_and_pick_up_do_not_translate", DisplayName = "Table and pickup")]
    [DataRow("demo_confirms_buffered_gait_and_turns", DisplayName = "Buffered walking start and corner")]
    [DataRow("replay_is_deterministic", DisplayName = "Same pipeline replay")]
    [DataRow("walking_turn_advances_both_heading_and_position", DisplayName = "Walking 90 degree corner")]
    [DataRow("duplicate_batch_is_idempotent", DisplayName = "Network duplicate protection")]
    [DataRow("sequence_gaps_and_time_regression_are_rejected", DisplayName = "Sequence and timestamp validation")]
    [DataRow("single_peak_does_not_change_transport", DisplayName = "Temporal hysteresis")]
    [DataRow("declared_vehicle_switches_temporally_back_to_walking", DisplayName = "Mode transitions")]
    [DataRow("vehicle_constant_speed_is_not_claimed_from_quiet_imu", DisplayName = "Vehicle observability limit")]
    [DataRow("vehicle_without_orientation_freezes_translation", DisplayName = "Missing orientation")]
    [DataRow("quiet_vehicle_does_not_automatically_get_zupt", DisplayName = "No false stationary vehicle")]
    [DataRow("running_has_a_different_stride_model", DisplayName = "Separate running model")]
    [DataRow("calibration_scales_stride", DisplayName = "Personal stride calibration")]
    [DataRow("gps_good_poor_unavailable_good_keeps_tracking", DisplayName = "GPS quality transitions")]
    [DataRow("gps_jumps_are_rejected", DisplayName = "GPS jump rejection")]
    [DataRow("gps_correction_is_bounded_and_adds_no_distance", DisplayName = "GPS bounded correction")]
    [DataRow("geographic_roundtrip_uses_wgs84", DisplayName = "WGS84 conversion")]
    [DataRow("heatmap_accumulates_standing_time", DisplayName = "Stationary heatmap")]
    [DataRow("heatmap_distributes_distance_along_segment", DisplayName = "Movement heatmap")]
    [DataRow("meter_markers_follow_path_distance_not_displacement", DisplayName = "Cumulative metre markers")]
    [DataRow("protocol_rejects_nonfinite_and_unbounded_data", DisplayName = "Protocol validation")]
    [DataRow("replay_import_validates_all_sensor_vectors", DisplayName = "Recording validation")]
    [DataRow("coordinate_rotation_preserves_vector_magnitude", DisplayName = "Navigation frame transformation")]
    [DataRow("benchmark_does_not_invent_missing_ground_truth", DisplayName = "Benchmark missing truth")]
    [DataRow("low_sample_rate_degrades_to_unknown", DisplayName = "Sensor degradation")]
    [DataRow("speed_remains_stable_between_step_observations", DisplayName = "Step speed hold")]
    [DataRow("gps_heading_support_affects_subsequent_step_positions", DisplayName = "GPS heading support")]
    [DataRow("sensor_dropout_resets_temporal_evidence", DisplayName = "Sensor dropout reset")]
    public async Task TestThat_production_motion_scenario_passes(string scenario)
    {
        var root = FindRepository();
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("NODE_BINARY") ?? "node")
        {
            WorkingDirectory = root, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true
        };
        start.ArgumentList.Add("--test");
        start.ArgumentList.Add($"--test-name-pattern=^TestThat_{scenario}$");
        start.ArgumentList.Add("tests/motion.test.js");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Node could not start");
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        var log = await output + await errors;
        Assert.AreEqual(0, process.ExitCode, log);
        StringAssert.Contains(log, "pass 1", "Ensure the selected JavaScript scenario was executed. " + log);
    }

    private static string FindRepository()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Combine(current.FullName, "package.json")))
            current = current.Parent;
        return current?.FullName ?? throw new DirectoryNotFoundException("Repository root missing");
    }
}
