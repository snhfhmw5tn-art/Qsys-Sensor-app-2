# Walking direction independent of phone pose

Reviewed 2026-10-08. The active green estimator is a **browser adaptation**, not a reproduction or validation of a published algorithm.

## Primary sources

- Deng et al., 2015, [Heading Estimation for Indoor Pedestrian Navigation Using a Smartphone in the Pocket](https://www.mdpi.com/1424-8220/15/9/21518). RMPCA transforms acceleration to a common frame, extracts the horizontal principal axis and handles turns. Pocket-specific assumptions and 180-degree ambiguity matter.
- Deng et al., 2016, [Carrying Position Independent User Heading Estimation](https://www.mdpi.com/1424-8220/16/5/677). Recognizes carrying position and selects heading strategies; distinguishes position transitions from turns using acceleration changes.
- Deng et al., 2018, [Robust Heading Estimation Using Unconstrained Smartphones](https://onlinelibrary.wiley.com/doi/10.1155/2018/5607036). Sections 3–4: windows of twice the step period, 50% overlap; distinguish hand movements, carrying transitions and turns; RMPCA during normal walking, horizontal gyro change during turns, neighboring normal steps during disturbances, and retrospective outlier removal. Assumes a carrying transition and a body turn do not occur simultaneously. Its attitude filter uses raw magnetometer data and an EKF; its carrying classifier is trained.
- Guo et al., 2021, [Pedestrian Heading Estimation Methods Based on Multiple Phone Carrying Modes](https://onlinelibrary.wiley.com/doi/10.1155/2021/1193268). Different methods for calling, pocket and swinging; combines rotation-axis and PCA methods for pocket use. These specific placement models cannot be assumed to work for arbitrary hand poses.
- Herath et al., ICRA 2020, [RoNIN](https://arxiv.org/abs/1905.12853), [code](https://github.com/Sachini/ronin). Learned inertial position and heading models and evaluation datasets. A candidate for separate offline evaluation; no RoNIN model is installed or run by this app.
- Yan et al., ECCV 2018, [RIDI](https://yanhangpublic.github.io/ridi/index.html). Learns velocity from acceleration and angular-velocity histories and corrects acceleration bias before integration. Not implemented here.

## Active implementation: three-strategy browser variant

Model identifier: `deng-2018-three-strategy-browser-v1`. This supersedes both previous per-step/offset hybrids and the orange-plus-offset estimator.

- Normal gait: each confirmed step uses PCA of navigation-frame horizontal acceleration. Initial reliable gait establishes alignment to the map's initial zero direction. Subsequent PCA directions are not recalibrated to the phone's current heading.
- Turns: integrate the gravity-axis gyroscope between the original timestamps of successive footfalls and add that change to the previous travel heading. Gyro integrals are stored with raw processed samples, so delayed footfall confirmations cannot include later rotation.
- Hand movement / position transition: hold the previous travel direction provisionally. Overlapping classification windows may retrospectively reclassify recent steps. When two normal steps exist before and two after the disturbance, circular-average those four headings and rebuild the affected green route (section 4.2, K=4). Do not average across turns or sensor gaps. If surrounding evidence is missing or inconsistent, the disturbance remains pending.
- Outliers: remove an isolated heading excursion with large opposite adjacent changes and agreeing neighbors. Preserve sustained turns (section 4.3).
- Classification uses windows of twice the measured step period, refreshed once per period (50% overlap). It records accumulated tilt, horizontal yaw, acceleration energy and gait-axis evidence.
- Arrow, green trajectory and exported headings use the same calculated travel heading. Orange processing, orange markers and step detection remain unchanged.

## Explicit differences from the complete paper

The browser supplies attitude instead of the paper's raw magnetometer/quaternion EKF. The carrying-state classifier uses experimental thresholds, not a trained Random Forest. PCA sign is selected by gyro continuity, not the pocket-specific vertical/forward phase method from RMPCA. Initial reliable gait defines relative zero; there is no external absolute-heading anchor. These differences are recorded in every export. Do not describe this as a bit-for-bit reproduction or claim the paper's accuracy.

Simultaneous phone repositioning and body turning violate a central assumption of the paper and remain ambiguous. Pure horizontal hand rotation, weak gait, changing acceleration patterns, attitude errors and reversals can still be misclassified. A disturbance without sufficient normal neighbors is left pending rather than guessed.

## Verification

Synthetic tests cover acceleration-derived normal headings independent of phone yaw, arbitrary grip changes with four-neighbor reconstruction, 45/90/180-degree and left turns, gyro sign, delayed step confirmations, unreliable orientation, isolated outliers versus sustained turns, sensor gaps and exported diagnostics. These do not establish real-world walking accuracy. Replay labeled measured routes and test physical phone poses before making accuracy claims.
