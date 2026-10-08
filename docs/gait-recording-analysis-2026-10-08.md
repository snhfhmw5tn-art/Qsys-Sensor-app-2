# Walking recordings, 2026-10-08

Four operator-labeled recordings from c954c7d were replayed through the updated tracker, including raw motion and independent orientation events in timestamp order. No test label or handset placement was supplied to the activity classifier. Raw personal recordings remain outside Git.

| Test | Samples | Duration (s) | Recorded steps | Updated detector steps |
| --- | ---: | ---: | ---: | ---: |
| Walking, upright | 870 | 14.48 | 26 | 26 |
| Standing, upright | 317 | 5.27 | 0 | 0 |
| Walking, swinging hand | 848 | 14.37 | 0 | 15 |
| Walking, pocket | 776 | 12.91 | 0 | 18 |

These are detector outputs, not verified actual step counts. There is no annotated footfall count or known distance in these files; exact accuracy and possible half-stride undercounting cannot be established.

Feature windows after the first three seconds:

| Test | Median acceleration RMS (m/s2) | Median gyro RMS (deg/s) | Median autocorrelation |
| --- | ---: | ---: | ---: |
| Upright walking | 3.07 | 36.15 | 0.949 |
| Standing | 0.196 | 2.674 | 0.570 |
| Swinging walking | 6.877 | 130.356 | 0.941 |
| Pocket walking | 10.377 | 163.110 | 0.886 |

Findings and changes:
- The hard gyro RMS <100 deg/s step gate rejected all swinging and pocket footsteps. Remove that orientation-dependent veto while retaining three regularly spaced peaks, minimum sample rate, autocorrelation, orientation reliability and horizontal motion evidence. Single spikes and vertical-only phone lifting remain rejected by the existing regression tests.
- Autocorrelation often picks a whole stride near 1 Hz, not the 2 Hz footfall rhythm. Use cadence from three confirmed peaks when available for activity classification, rather than assuming every autocorrelation maximum represents one step.
- Pocket impacts contain substantial energy above 4 Hz (90th percentile ratio 0.72). Do not veto them solely on vibration spectrum when regular footfalls corroborate gait. Mechanical vibration without corroboration keeps the existing spectral veto.
- Standing hand tremor crosses the old 0.2 RMS cutoff. Accept RMS <0.3 only together with gyro RMS <5, vertical amplitude <0.8 and horizontal energy <0.04. Do not infer stopping an already coasting vehicle from quiet sensors.

In the updated replay, all classified motion samples after 3 s are Walking in each walking test, and Standing in the standing test. That is resubstitution on four short tuning recordings, not independent validation or a calibrated probability. No running, cart, forklift or standing-with-arm-motion recordings were supplied. The data cannot validate discrimination from those activities. High acceleration amplitude alone is not proof of running: the pocket walking RMS exceeded upright walking several-fold.

Reproduce with the bundled Node executable and:

    node tools/analyze-gait.mjs <recording1.json> <recording2.json> ...

The script prints aggregate percentiles, classification counts, recorded steps and replayed steps without uploading the recordings. The orange phone-heading reference and geometry are unchanged. Newly accepted footsteps can naturally add more distance to the orange route.
