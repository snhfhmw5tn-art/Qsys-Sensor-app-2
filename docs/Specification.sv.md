Bygg en komplett webbaserad prototyp för rörelse-, transport- och relativ positionering med hjälp av mobilens/handdatorns egna sensorer.

Applikationen ska fungera i mobil webbläsare och använda telefonens sensorer via tillgängliga webb-API:er.

Systemet ska bestå av två tydligt separerade delar:

1. Klient i mobilen/handdatorn
2. Server

Målet är att avgöra hur användaren transporterar sig och därefter använda rätt beräkningsmodell för position, sträcka och hastighet.

Systemet ska kunna identifiera minst:

- Standing
- Walking
- Running
- TurningInPlace
- WalkingTurn
- Vehicle
- Forklift
- Scooter
- Unknown

Det ska i realtid visa:

- hur användaren rört sig
- aktuell relativ position
- färdriktning
- total sträcka i meter
- aktuell hastighet
- utjämnad hastighet
- antal steg när det är relevant
- transportläge
- confidence
- trajectory
- heatmap
- vilka sensorer som används
- om GPS används för positionskorrigering

Systemet måste vara forskningsbaserat.

# FORSKNINGSKRAV

Alla viktiga:

- beräkningar
- filter
- signalbehandlingsmetoder
- tröskelvärden
- tidsfönster
- classifier-metoder
- sensorfusion
- step detection
- stride estimation
- turn detection
- stationary detection
- GPS-korrigering
- hastighetsutjämning

ska så långt möjligt baseras på etablerad forskning inom området.

Utgå framför allt från forskning inom:

- Pedestrian Dead Reckoning, PDR
- Human Activity Recognition, HAR
- smartphone inertial navigation
- inertial odometry
- sensor fusion
- arbitrary smartphone orientation
- activity classification
- turn detection
- step detection
- stride length estimation
- vehicle dead reckoning
- zero velocity / stationary constraints
- GPS + inertial fusion
- map matching

Skapa:

docs/MotionResearch.md

För varje viktig algoritm ska dokumentet beskriva:

- vilken metod som används
- forskningsreferens
- varför metoden valts
- vilka parametrar som används
- vilka parametrar som behöver kalibreras
- vilka kända begränsningar som finns

Använd i första hand:

- peer-reviewed forskning
- review-artiklar
- vetenskapliga konferenser
- etablerade tekniska publikationer

Använd inte blogginlägg som primär vetenskaplig grund.

Om forskningen visar att något INTE går att beräkna tillförlitligt med enbart smartphone-sensorer ska implementationen inte låtsas kunna göra det exakt.

Använd uncertainty/confidence.

# WEBBAPPLIKATION

Applikationen ska vara webbaserad.

Den ska fungera på moderna mobila webbläsare via HTTPS.

Använd tillgängliga browser-API:er för exempelvis:

- accelerometer / DeviceMotion
- gyroscope / rotationRate
- DeviceOrientation
- Geolocation
- Screen Orientation där relevant

Hantera att vissa webbläsare kräver att användaren explicit trycker på START innan sensorbehörigheter kan begäras.

Skapa tydlig hantering av:

- permission granted
- permission denied
- sensor unavailable
- sensor data stopped
- unsupported browser

Tracking ska degradera kontrollerat om en viss sensor saknas.

# ÖVERGRIPANDE ARKITEKTUR

Klienten ska läsa sensorer med relativt hög frekvens.

Exempel:

50–100 Hz när browser/device tillåter det.

ALL rå sensordata ska INTE kontinuerligt skickas till servern.

Arkitekturen ska vara:

MOBILE WEB CLIENT

Accelerometer
Gyroscope
Orientation
Gravity
GPS/Geolocation
        ↓
Sensor preprocessing
        ↓
Coordinate transformation
        ↓
Feature extraction
        ↓
Activity / transport classification
        ↓
Step / turn / stationary / vehicle detection
        ↓
MotionObservation aggregation
        ↓
4–10 nätverksuppdateringar/s ungefär
        ↓

SERVER

Motion observation processing
        ↓
Transport-specific motion model
        ↓
Heading
        ↓
Position X/Y
        ↓
Distance
        ↓
Speed
        ↓
Trajectory
        ↓
Heatmap
        ↓
GPS correction / fusion

# KLIENTENS ANSVAR

Klienten ska göra den signalbehandling som behöver hög sensorfrekvens.

Det inkluderar:

- sensoravläsning
- timestamps
- buffering
- signalfilter
- gravity estimation/removal
- device orientation
- coordinate transformation
- feature extraction
- activity classification
- step candidate detection
- confirmed step detection
- turn detection
- stationary detection
- vibration analysis
- vehicle-related features
- confidence

Klienten ska INTE vara authoritative för slutlig global/relativ position.

# SERVERNS ANSVAR

Servern ska vara authoritative för:

- aktuell position
- trajectory
- heading
- total sträcka
- aktuell hastighet
- smoothed speed
- heatmap
- sessionhistorik
- position confidence
- eventuell GPS-korrigering
- framtida map matching

# TRANSPORTMODE

Implementera minst:

Unknown
Standing
Walking
Running
TurningInPlace
WalkingTurn
Vehicle
Forklift
Scooter

Skapa dessutom en övergripande MotionFamily:

Stationary
Pedestrian
Vehicle
Unknown

Transportläget ska styra vilken rörelsemodell servern använder.

Exempel:

Standing
→ StationaryMotionModel

Walking
→ WalkingMotionModel

Running
→ RunningMotionModel

Forklift
→ VehicleMotionModel

Scooter
→ VehicleMotionModel

Unknown
→ ConservativeMotionModel

Det får INTE finnas en universalalgoritm som används för all transport.

# TRANSPORTLÄGESVÄXLING

TransportMode får inte bytas på en enstaka sensorpeak.

Använd forskningsbaserad temporal stabilisering.

Implementera:

- confidence
- hysteresis
- minimum state duration
- candidate state
- temporal consistency

Exempel:

Walking
→ VehicleCandidate
→ Vehicle

och inte:

Walking
→ Vehicle

på en enskild vibration.

# ACTIVITY RECOGNITION

Klassificera aktivitet över glidande tidsfönster.

Undvik:

if acceleration > X then Walking

Extrahera forskningsbaserade features som exempelvis:

- acceleration magnitude
- linear acceleration
- gyro magnitude
- RMS
- variance
- standard deviation
- signal energy
- jerk
- dominant frequency
- periodicity
- autocorrelation
- cadence
- peak intervals
- horizontal acceleration
- vertical acceleration
- angular velocity
- heading rate

Skapa:

IMotionFeatureExtractor
IMotionClassifier

Första versionen får använda en forskningsbaserad regelmodell.

Arkitekturen ska senare kunna ersätta den med ML utan att övriga systemet behöver skrivas om.

# MOBILENS ORIENTERING

Detta är mycket viktigt.

Telefonen kan vara:

- portrait
- landscape vänster
- landscape höger
- liggande plant
- vinklad
- i handen
- nära kroppen

Systemet får INTE använda telefonens råa X/Y/Z som om de motsvarar användarens rörelseriktning.

Transformera:

Device coordinate frame
→ Local navigation frame

Använd:

- gravity
- gyroscope
- orientation
- quaternion eller rotationsmatris

enligt etablerad forskning.

# START

När användaren trycker START:

- initiera sensorpermissions
- samla en kort kalibreringsperiod
- uppskatta gravity
- uppskatta gyro-bias där möjligt
- position = 0,0
- distance = 0
- elapsed time = 0

Initial rörelseriktning ska alltid visuellt vara:

Rakt fram / uppåt på den lokala kartan.

Detta ska gälla oavsett hur mobilen hålls.

Heading vid start:

0°

Telefonens fysiska screen orientation får alltså inte avgöra vad som visas som framåt.

# DEVICE ORIENTATION VS TRAVEL DIRECTION

Separera uttryckligen:

DeviceOrientation

från:

TravelHeading

Telefonens ovansida behöver inte peka i samma riktning som användaren går.

För Walking/Running ska systemet använda rörelsedata för att förbättra TravelHeading-estimeringen.

Utvärdera forskningsmetoder såsom:

- navigation-frame acceleration
- gait direction estimation
- PCA-baserad rörelseriktningsestimering

om dessa är lämpliga för handheld smartphone.

# GYRO

Gyro ska användas för relativa rotationsförändringar.

Gyro ska INTE generera sträcka.

Exempel:

personen står still
vrider sig 180°
står still

Resultat:

HeadingDelta ≈ 180°
DistanceDelta = 0
PositionDelta = 0

# TURNING IN PLACE

Systemet måste skilja mellan:

- att stå och vända kroppen
- att gå runt en sväng

Om:

- angular velocity är hög
- inget stabilt gait pattern finns
- ingen säker translation finns

ska state bli:

TurningInPlace

Position ska inte förändras.

# WALKING TURN

Om användaren:

- fortsätter gå
- tar giltiga steg
- samtidigt roterar

ska state bli:

WalkingTurn

Då förändras:

- heading
- position
- distance

# STEP DETECTION

För gång och löpning ska stegdetektion baseras på etablerad smartphone-PDR.

Använd inte endast en threshold på en rå sensoraxel.

Stegdetektion bör använda en kombination av exempelvis:

- acceleration magnitude
- navigation-frame vertical acceleration
- filtering
- peak detection
- cadence
- periodicity
- temporal consistency

Implementera:

CandidateStep
ConfirmedStep

# FALSKA STEG

Följande ska normalt INTE skapa ConfirmedStep:

- handen skakar
- mobilen läggs på ett bord
- mobilen plockas upp
- mobilen flyttas mellan händer
- mobilen stoppas i fickan
- mobilen tas ur fickan
- användaren vänder sig på plats

En ensam accelerationpeak är aldrig tillräcklig.

# WALKING START

De första stegen får buffras.

Exempel:

Candidate 1
Candidate 2
Candidate 3
→ Walking confirmed

De giltiga buffrade stegen kan sedan appliceras retroaktivt.

Detta ska förhindra både:

- falska enstaka steg
- förlorad sträcka i början

# WALKING DISTANCE

Walking ska i första hand använda PDR:

confirmed step
+
estimated stride/step length
+
heading

→ position delta

Använd inte fri dubbelintegration av accelerometerdata för normal gång.

Telefonen ska skicka tillräckliga StepFeatures till servern för stride estimation utan att skicka rå sensordata.

Exempel på möjliga features:

- cadence
- step interval
- acceleration amplitude
- vertical amplitude
- signal energy
- motion confidence

De exakta features ska bestämmas från forskningen.

# RUNNING

Running ska ha separat modell.

Running och Walking får inte dela exakt samma stride-modell.

Ta hänsyn till:

- cadence
- acceleration amplitude
- gait characteristics
- step interval

# VEHICLE / SCOOTER / FORKLIFT

Sparkcykel och truck saknar användbar stegbaserad sträckmodell.

VehicleMotionModel ska därför använda en forskningsbaserad kombination av:

- orientation-corrected acceleration
- gyro
- stationary detection
- bias correction
- short-window inertial integration
- motion constraints

Var tydlig med begränsningen:

En smartphone kan inte direkt mäta konstant hastighet från accelerometern.

Om fordonet rullar med konstant fart blir acceleration nära noll.

Ren dubbelintegration ger drift.

Systemet ska därför ha:

VehicleDistanceConfidence

som sjunker vid lång kontinuerlig körning utan korrigerande observation.

# STATIONARY DETECTION

Standing/stationary detection är mycket viktig.

När systemet med hög confidence vet att användaren eller fordonet verkligen står still ska det kunna använda detta för:

- velocity constraint
- gyro bias correction
- acceleration bias correction
- drift reduction

Applicera INTE klassisk foot-mounted ZUPT vid varje gångsteg på en handhållen mobil.

# GPS / GEOLOCATION

Använd browserns Geolocation API när det är tillgängligt.

GPS/geolocation ska vara en EXTRA positioneringskälla och inte ett krav.

GPS ska kunna hjälpa till med:

- absolut position
- drift correction
- speed support
- heading support

om signalen bedöms tillförlitlig.

# GPS KVALITET

Skapa:

IGpsQualityEvaluator

GPS får inte automatiskt användas bara för att en position returneras.

Bedöm minst:

- coords.accuracy
- mätningens ålder
- konsistens mot tidigare fixes
- fysisk rimlighet
- current motion state
- skillnaden mellan GPS och uppskattad position

Returnera exempelvis:

Unavailable
Rejected
Poor
Moderate
Good
Excellent

samt:

GpsConfidence 0..1

och:

UseForCorrection true/false

Thresholds ska vara konfigurerbara och forsknings-/testmotiverade.

# GPS SENSOR FUSION

GPS ska kunna korrigera PDR/inertialposition när GPS-signalen är tillräckligt bra.

Använd en etablerad sensorfusion-metod.

Utvärdera exempelvis:

- Kalman filter
- Extended Kalman filter
- covariance-weighted fusion

Välj metod baserat på forskningen och lösningens komplexitet.

GPS-positionen får normalt inte orsaka ett abrupt hopp om det kan undvikas.

Korrigera baserat på osäkerheten i:

- GPS
- PDR
- heading
- current transport mode

# SENSORSTATUS I UI

Huvudvyn ska mycket tydligt visa vilka sensorer som finns och vilka som faktiskt används.

Exempel:

SENSORS

Accelerometer        ACTIVE
Gyroscope            ACTIVE
Orientation          ACTIVE
Gravity              ACTIVE
Magnetometer         LIMITED
GPS                   ACTIVE

Det ska finnas skillnad mellan:

Available
Reliable
Used

Exempel:

GPS:
Available = true
Reliable = false
UsedForCorrection = false

# GPS STATUS

Visa tydligt:

GPS available
GPS accuracy
Last fix
GPS speed
GPS heading
GPS quality
GPS correction active
GPS correction weight/influence

Exempel:

GPS
Accuracy: 5.8 m
Quality: GOOD
Correction: ACTIVE
Influence: 32 %

eller:

GPS
Accuracy: 41 m
Quality: POOR
Correction: OFF

Reason:
Accuracy too low

# POSITION SOURCES

Visa tydligt vilka källor som påverkar positionen.

Exempel:

POSITION SOURCES

PDR / IMU          71 %
GPS correction     29 %

eller:

Vehicle inertial   100 %
GPS correction       0 %

Vikten får inte vara kosmetisk.

Den ska reflektera verklig fusion/confidence.

# MOTION OBSERVATION PROTOCOL

Skicka inte raw IMU kontinuerligt till servern.

Skapa ett kompakt protokoll.

Varje paket ska minst ha:

ProtocolVersion
DeviceId
SessionId
SequenceNumber
MonotonicTimestamp

ObservationType
MotionMode
ModeConfidence
HeadingDelta
ObservationConfidence

ObservationType kan exempelvis vara:

Heartbeat
StateChanged
Step
Turn
Stationary
MotionWindow
VehicleMotion
GpsFix

# STEP OBSERVATION

Kan exempelvis innehålla:

Timestamp
Cadence
StepInterval
AccelerationAmplitude
VerticalAmplitude
SignalEnergy
MotionConfidence

Servern beräknar stride/distance enligt vald modell.

# VEHICLE OBSERVATION

Kan exempelvis innehålla aggregerade features över ett kort tidsfönster:

TimestampStart
TimestampEnd
HeadingDelta
ForwardAccelerationMean
ForwardAccelerationVariance
AccelerationIntegral
VibrationEnergy
DominantFrequency
StationaryProbability
ModeConfidence
ObservationConfidence

Skicka inte onödiga råsensorvärden om motsvarande information kan skickas som features.

# NÄTVERKSFREKVENS

Sensorerna kan arbeta med cirka:

50–100 Hz

Men nätverksuppdateringar ska normalt ligga omkring:

4–10 Hz

under rörelse.

När användaren står still ska trafiken minska ytterligare.

Skicka då främst:

- state changes
- heartbeat
- viktiga corrections

# NETWORK LOSS

Mobilen ska klara dåligt lager-Wi-Fi.

Implementera:

- SequenceNumber
- lokal outgoing buffer
- retry
- batchning
- duplicate protection
- idempotent server processing

Servern ska exempelvis identifiera observationer med:

SessionId + SequenceNumber

# TIMESTAMPS

Alla rörelseberäkningar ska använda observationens mättid.

Använd monotonic elapsed time där browsern tillåter.

Servern ska INTE beräkna rörelse utifrån när nätverkspaket råkade anlända.

# RAW SENSOR RINGBUFFER

Behåll rå IMU-data lokalt under en begränsad period, exempelvis:

30–60 sekunder.

Normalt skickas den INTE.

Rådata ska kunna exporteras/skickas vid:

- debug mode
- låg confidence
- anomaly
- explicit diagnostic request

# RECORDING / REPLAY

Detta är ett absolut krav.

Skapa:

ISensorSource

med minst:

LiveSensorSource
ReplaySensorSource

En inspelad session ska kunna köras genom exakt samma pipeline som live-data.

Man ska kunna:

1. spela in en verklig promenad
2. spara sensordata
3. ändra algoritmen
4. spela upp samma data
5. jämföra resultat

# GROUND TRUTH

Skapa testfunktion där användaren kan markera:

I AM STANDING
I AM WALKING
I AM RUNNING
I AM ON FORKLIFT
I AM ON SCOOTER
I AM TURNING

Skapa även möjlighet att markera:

KnownDistance
KnownPosition

för kalibrering och forskning.

# SERVER POSITION

Serverns PositionState ska minst innehålla:

X
Y
Heading

TotalDistance

WalkingDistance
RunningDistance
VehicleDistance

InstantaneousSpeed
SmoothedSpeed

MotionMode
MotionConfidence

HeadingConfidence
PositionConfidence

LastTimestamp

# HASTIGHET

Visa:

InstantaneousSpeed

och:

SmoothedSpeed

Använd forskningsbaserad utjämning.

Hastighet ska inte hoppa kraftigt på grund av timestamp-jitter eller enskilda observationer.

Dokumentera valt filter.

# TOTAL STRÄCKA

Total sträcka är en central funktion.

Den ska alltid visas tydligt.

Exempel:

DISTANCE
126.4 m

Visa även uppdelning:

Walking       42.8 m
Running        8.3 m
Vehicle       75.3 m

TotalDistance ska vara faktisk ackumulerad trajectory distance och inte fågelvägsavstånd mellan start och slut.

# HUVUDVY

Skapa en tydlig mobilvänlig realtidsvy.

Visa permanent:

Transport mode

GÅR
STÅR
SPRINGER
VÄNDER
TRUCK
SPARKCYKEL
OSÄKER

Samt:

Distance
Speed
Heading
Steps
Elapsed time
Motion confidence
Position confidence

Exempel överst:

GÅR     42.7 m     1.36 m/s

# TRAJECTORY

Visa användarens rekonstruerade bana i realtid.

Startpunkten ska vara tydligt markerad.

Aktuell position ska ha riktningspil.

# METERMARKERINGAR

Det är mycket viktigt att man visuellt kan bedöma sträckan.

Trajectory ska ha tydliga meterbaserade markörer.

Exempel:

- grid varje 1 m vid hög zoom
- tydligare grid varje 5 m
- etikett var 10 m

Trajectory ska också ha cumulative distance markers.

Exempel:

START
  ●
  │
  ● 5 m
  │
  ● 10 m
  │
  ● 15 m

Avståndet ska mätas längs banan.

Inte fågelvägsavstånd från start.

Markörtäthet ska automatiskt anpassas efter zoomnivå.

# KARTBAKGRUND

Användaren ska kunna välja:

BACKGROUND

[ NONE ]
[ GOOGLE MAPS ]

Detta är ENDAST ett visualiseringsval.

Det får inte påverka positioneringsmotorn.

# NO BACKGROUND

Standardläge ska vara:

NONE

Visa då en ren lokal X/Y-karta.

Visa:

- metergrid
- trajectory
- start
- current position
- heading
- heatmap
- meter markers
- scale

Systemet ska fungera fullt utan:

- internet
- Google Maps
- Google API key

# GOOGLE MAPS

Google Maps ska kunna väljas som bakgrund.

Använd Google Maps JavaScript API.

Google Maps ska endast fungera som:

- geografisk bakgrund
- geografisk kontext
- visualisering

Vår positioneringsmotor är fortfarande authoritative.

Rita vår egen trajectory ovanpå Google Maps.

# GPS ÄR INTE GOOGLE MAPS

Detta ska vara helt separerat.

GPS kan användas även när:

Background = NONE

och:

Google Maps kan visas även om GPS för tillfället inte används för correction.

Arkitekturen måste skilja:

GPS source
Position engine
Map renderer

# MAP RENDERERS

Skapa:

IMapRenderer

med minst:

LocalMapRenderer
GoogleMapsRenderer

Båda använder samma:

TrajectoryState
PositionState
HeatmapState

Ingen positionsalgoritm får ligga i GoogleMapsRenderer.

# GOOGLE MAPS FAILURE

Om Google Maps inte går att ladda:

- tracking ska fortsätta
- byt automatiskt till LocalMapRenderer
- visa meddelande

"Google Maps unavailable. Tracking continues."

# GPS POSITION PÅ GOOGLE MAPS

När en tillräckligt bra GPS-position finns ska lokal position kunna förankras geografiskt.

Local:

X/Y i meter

Geographic:

Latitude/Longitude

Använd etablerade geodesiska metoder för konverteringen.

Undvik dåliga egna lat/lon-approximationer när etablerade funktioner finns.

# GPS ACCURACY VISUALIZATION

Vid Google Maps / debug mode:

Visa rå GPS-fix separat från fused position.

Visa GPS accuracy circle.

Exempel:

GPS raw position
GPS accuracy radius
Predicted PDR position
Fused position

Det ska visuellt gå att se GPS-korrigeringen.

# HEATMAP

Servern ska generera heatmap.

Dela den lokala positionen i grid-celler.

Cellstorlek ska vara konfigurerbar, exempelvis:

0.5 x 0.5 meter.

Lagra minst:

TimeSpent
VisitCount
DistanceTravelled
AverageSpeed
StandingTime
WalkingTime
RunningTime
VehicleTime

Visa heatmap modes:

TIME
SPEED
VISITS
TRANSPORT

TIME:

Om användaren står länge på samma plats ska området bli tydligt varmt.

SPEED:

Snabb transport ska skilja sig från långsam gång/stillastående.

VISITS:

Visa ofta besökta områden.

TRANSPORT:

Visa områden där olika transportlägen dominerat.

Heatmap ska fungera både:

- utan bakgrund
- ovanpå Google Maps

# DEBUG / DIAGNOSTICS

Skapa en expanderbar debugpanel.

Visa:

Accelerometer
X/Y/Z
Magnitude
Sampling rate

Gyroscope
X/Y/Z
Magnitude
Sampling rate

Gravity
X/Y/Z

Orientation
Pitch
Roll
Relative yaw
Quaternion om tillgängligt

GPS
Latitude
Longitude
Accuracy
Speed
Heading
Age
Quality
UsedForCorrection
CorrectionWeight

Motion
Current mode
Candidate mode
Confidence

Step detection
Candidate steps
Confirmed steps
Rejected steps
Cadence

Heading
Raw heading
Filtered heading
Heading confidence

Position
X
Y
Distance
Speed
Position confidence

# EVENT LOG

Logga viktiga events.

Exempel:

12:04:03.120 CandidateStep
12:04:03.450 CandidateStep
12:04:03.880 WalkingConfirmed
12:04:03.881 BufferedStepsApplied
12:04:08.210 TurnStarted
12:04:09.011 HeadingDelta=91.2
12:04:09.105 WalkingTurn
12:04:14.220 Standing
12:04:17.410 GpsFixAccepted
12:04:17.411 GpsCorrectionApplied

# CONFIDENCE

Confidence är viktigt.

Implementera minst:

MotionConfidence
TransportModeConfidence
HeadingConfidence
PositionConfidence
GpsConfidence
VehicleDistanceConfidence

PositionConfidence ska bland annat kunna sjunka vid:

- lång tid utan absolut correction
- vehicle travel
- dålig GPS
- gyro drift
- sensor dropout
- Unknown
- stor orientation uncertainty
- låg motion classification confidence

# KALIBRERING

Skapa möjlighet att kalibrera Walking/Running mot känd sträcka.

Exempel:

"Walk 10 meters"

ActualDistance = 10 m.

Använd resultatet för att förbättra stride length-modellen.

Spara kalibreringsdata på ett strukturerat sätt.

# TESTER

Skriv omfattande automatiserade tester.

Använd MSTest.

Testmetoder ska alltid börja med:

TestThat

och därefter snake_case.

Exempel:

TestThat_turning_in_place_does_not_add_distance

Använd:

[TestMethod]

och:

[DataRow(..., DisplayName = "...")]

när DataRow passar.

Använd Assert.ThrowsExactly<T> vid exception-tester.

Hjälpmetoder ska använda PascalCase.

Om .NET Framework används ska target vara .NET Framework 4.8 om solutionen inte uttryckligen kräver något annat.

# TESTSCENARIER

Testa minst:

1.

Walk straight
Stop
Turn 180° while standing
Walk back

Förväntat:

turn adds no distance

2.

Stand still
Rotate 360°

Förväntat:

distance ≈ 0

3.

Portrait walking

och:

Landscape walking

Förväntat:

båda börjar visuellt rakt fram

4.

Stand still and shake phone

Förväntat:

ingen betydande translation

5.

Put phone on table

Förväntat:

ingen walking distance

6.

Pick phone up

Förväntat:

ingen walking distance utan faktiskt gait pattern

7.

Walk around 90° corner

Förväntat:

WalkingTurn

8.

Walking
→ Scooter/Forklift
→ Walking

Förväntat:

rätt beräkningsmodell växlas automatiskt

9.

GPS good
→ poor
→ unavailable
→ good

Förväntat:

GPS correction weight minskar och återkommer utan att tracking stoppas

10.

Google Maps enabled
→ Google Maps unavailable

Förväntat:

tracking fortsätter i LocalMapRenderer

# REPLAY-BENCHMARK

För samma inspelade dataset ska två algoritmversioner kunna jämföras.

Rapportera:

- transport mode accuracy
- false state transitions
- confirmed steps
- false steps
- heading error
- distance error
- endpoint error
- trajectory error
- GPS correction count

Detta ska göra att vi kan verifiera om en algoritmändring faktiskt förbättrar systemet.

# KODSTRUKTUR

Separera exempelvis:

ISensorSource

LiveSensorSource
ReplaySensorSource

SensorPipeline
SensorBuffer
SensorPreprocessor

GravityEstimator
OrientationEstimator
CoordinateTransformer

MotionFeatureExtractor
MotionClassifier
TransportModeStateMachine

StepDetector
StepValidator
StepFeatureExtractor

TurnDetector
StationaryDetector

GpsService
GpsQualityEvaluator

MotionObservationAggregator
MotionObservationSender
MotionObservationReceiver

TransportModeManager

StationaryMotionModel
WalkingMotionModel
RunningMotionModel
VehicleMotionModel
ConservativeMotionModel

HeadingEstimator
PositionEstimator
GpsPositionFusion
SpeedEstimator

TrajectoryService
HeatmapService

IMapRenderer
LocalMapRenderer
GoogleMapsRenderer

SessionRecorder
ReplayService
GroundTruthService

Undvik God Classes.

# KONFIGURATION

Samla algoritmparametrar centralt.

Inga utspridda magic numbers.

Konfiguration ska omfatta exempelvis:

- filter cutoff
- filter order
- activity window
- overlap
- step timing
- state transition confidence
- hysteresis
- GPS quality parameters
- network aggregation interval
- heatmap cell size

# FILTERKRAV

Använd inte ett godtyckligt filter såsom:

alpha = 0.8

utan att dokumentera varför.

För varje viktigt filter:

- filtertyp
- sampling rate
- cutoff
- order
- signal
- syfte
- forskningsreferens
- konfigurerbara parametrar

ska framgå.

# UI-KRAV

Huvudvyn ska vara enkel att förstå.

Överst exempelvis:

GÅR
42.7 m
1.36 m/s

Under:

Position confidence 91 %

Sensors:
ACC ✓
GYRO ✓
GPS ✓

GPS correction:
ACTIVE

Background:
[None] [Google Maps]

Sedan kartan/trajectory.

Under eller i en expanderbar panel:

- heatmap controls
- diagnostics
- event log
- recording/replay

# VIKTIGASTE DESIGNPRINCIPER

1. Transportläget väljer beräkningsmodell.

2. Walking/Running använder i första hand step-based PDR.

3. Truck/Scooter använder separat vehicle inertial model.

4. Rotation är inte samma sak som translation.

5. TurningInPlace ska ge 0 meter.

6. Smartphone orientation får inte avgöra användarens färdriktning direkt.

7. GPS används opportunistiskt som absolut correction när kvaliteten är tillräcklig.

8. GPS och Google Maps är helt separata funktioner.

9. Google Maps är en valbar visuell bakgrund.

10. Appen måste fungera helt utan Google Maps.

11. Raw IMU-data behandlas lokalt och skickas inte kontinuerligt till servern.

12. Servern är authoritative för position, distance, speed och heatmap.

13. Alla betydande algoritmer och filter ska kunna motiveras med forskning.

14. Om precisionen inte kan garanteras ska uncertainty visas istället för falsk precision.

# ARBETSORDNING FÖR CODEX

Arbeta i denna ordning:

1. Inspektera befintlig solution/repository.
2. Dokumentera forskningsunderlaget.
3. Föreslå och dokumentera arkitekturen.
4. Implementera datamodell och interfaces.
5. Implementera webb-sensoråtkomst.
6. Implementera sensor preprocessing.
7. Implementera orientation/navigation frame.
8. Implementera motion feature extraction.
9. Implementera transport classification.
10. Implementera state machine.
11. Implementera step detection.
12. Implementera turn/stationary detection.
13. Implementera GPS quality evaluation.
14. Implementera MotionObservation-protokollet.
15. Implementera server-side movement models.
16. Implementera position och speed.
17. Implementera GPS fusion.
18. Implementera LocalMapRenderer.
19. Implementera GoogleMapsRenderer.
20. Implementera trajectory och meter markers.
21. Implementera heatmap.
22. Implementera sensorstatus.
23. Implementera recording/replay.
24. Implementera ground truth.
25. Implementera automatiserade tester.
26. Build solution.
27. Kör alla tester.
28. Fixa compile errors.
29. Fixa test failures.
30. Dokumentera faktisk precision och begränsningar.

Lämna inte TODO eller placeholder-kod där faktisk funktionalitet ska finnas.

När implementationen är klar:

- redovisa arkitekturen
- redovisa vilka forskningsmetoder som användes
- redovisa vilka sensorer som används
- redovisa vilka delar som behöver kalibrering
- redovisa kända begränsningar
- redovisa vilka parametrar som bör testas med riktig lagerdata
- redovisa hur mycket nätverkstrafik MotionObservation-protokollet genererar
- redovisa vilka delar som fungerar utan GPS
- redovisa hur GPS används när signalen är tillräckligt bra