# Walking direction independent of phone pose

Reviewed 2026-10-08. The active green estimator is a **browser adaptation**, not a reproduction or validation of a published algorithm.

## Primary sources

- Deng et al., 2015, [Heading Estimation for Indoor Pedestrian Navigation Using a Smartphone in the Pocket](https://www.mdpi.com/1424-8220/15/9/21518). RMPCA transforms acceleration to a common frame, extracts the horizontal principal axis and handles turns. Pocket-specific assumptions and 180-degree ambiguity matter.
- Deng et al., 2016, [Carrying Position Independent User Heading Estimation](https://www.mdpi.com/1424-8220/16/5/677). Recognizes carrying position and selects heading strategies; distinguishes position transitions from turns using acceleration changes.
- Deng et al., 2018, [Robust Heading Estimation Using Unconstrained Smartphones](https://onlinelibrary.wiley.com/doi/10.1155/2018/5607036). Sections 3–4: windows of twice the step period, 50% overlap; distinguish hand movements, carrying transitions and turns; RMPCA during normal walking, horizontal gyro change during turns, neighboring normal steps during disturbances, and retrospective outlier removal. Assumes a carrying transition and a body turn do not occur simultaneously. Its attitude filter uses raw magnetometer data and an EKF; its carrying classifier is trained.
- Guo et al., 2021, [Pedestrian Heading Estimation Methods Based on Multiple Phone Carrying Modes](https://onlinelibrary.wiley.com/doi/10.1155/2021/1193268). Different methods for calling, pocket and swinging; combines rotation-axis and PCA methods for pocket use. These specific placement models cannot be assumed to work for arbitrary hand poses.
- Herath et al., ICRA 2020, [RoNIN](https://arxiv.org/abs/1905.12853), [code](https://github.com/Sachini/ronin). Learned inertial position and heading models and evaluation datasets. A candidate for separate offline evaluation; no RoNIN model is installed or run by this app.
- Yan et al., ECCV 2018, [RIDI](https://yanhangpublic.github.io/ridi/index.html). Learns velocity from acceleration and angular-velocity histories and corrects acceleration bias before integration. Not implemented here.

## Implemented adaptation

`client/travel.js` selects motion states using a separate raw-sample buffer. Acceleration is already rotated into the navigation frame by `SensorPreprocessor`. Confirmed footfall intervals determine the analysis duration (two periods) and refresh interval (one period), giving approximately 50% overlap despite irregular browser events.

Each window records horizontal PCA, anisotropy, acceleration energy, accumulated tilt and gravity-axis gyro rotation. Gravity direction rather than raw Euler differences measures tilt, avoiding angle-wrap artifacts. Thresholds are experimental implementation choices, not published validated constants. Tilt/energy disturbances and disagreement between device rotation and gait axis delay mounting decisions. Continuing turns with compatible gait evidence preserve gyro-based heading without waiting for the phone to settle. Stable neighboring gait windows support a new grip offset and retrospective reconstruction of the affected green steps. Raw input, decisions, references and correction intervals are exported.

The orange route, step detector, stride, orange markers and map coordinate system are unchanged. Green remains provisional before sufficient evidence exists. Delayed confirmed steps are used at their original timestamps.

## Differences and unresolved cases

- Uses browser-provided attitude and the existing gyro heading filter, not the paper's raw magnetometer/quaternion EKF.
- Uses an explicit threshold classifier, not a trained Random Forest carrying-position classifier. There is no automatic validated pocket/calling/swinging model.
- Normal walking uses navigation-frame PCA over each confirmed step, with a fixed initial frame alignment, quality checks and continuity-based sign selection. An isolated heading outlier is corrected from its neighboring normal steps. Mounting corrections average stable neighboring windows rather than reproducing the paper's four-normal-step filter exactly.
- Does not implement the pocket-specific vertical/forward phase method for resolving the PCA axis sign. Ambiguous reversals remain uncertain; gyro turn evidence helps but does not prove body rotation.
- Simultaneous body turns and phone repositioning, pure horizontal hand rotations, weak gait and magnetic/attitude errors can still be confused. No universal accuracy guarantee follows from these papers.

## Validation

Automated tests cover raw two-step window decisions, a 37-degree grip change while walking straight, retrospective reconstruction, a continuing 90-degree turn, isolated disturbances, ambiguous reversals and evidence reset after a sensor gap. These are synthetic regression tests, not measured walking accuracy.

Before claiming improved real-world accuracy, replay labeled recordings with known straight segments, partial/90/180-degree turns and independently changed phone poses; measure heading error, route error, false corrections and decision delay. Compare against the same unchanged orange baseline. Test simultaneous turns and grip changes separately. Existing recordings without labeled ground truth cannot establish exact accuracy.
