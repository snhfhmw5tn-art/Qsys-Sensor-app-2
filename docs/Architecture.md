# Arkitektur

Mobilen kör ES-moduler: sensor source → preprocessing → navigation frame → 3 s feature window → regelklassificerare → temporal state machine → stegvalidering → observationer. Servern kör Node 22+ med ett separat positionsobjekt per session. Inga runtime-ramverk behövs. GeographicLib används för WGS84-geodesi. Samma klientpipeline används vid live, syntetisk demo och replay.

HTTP: POST /api/sessions skapar en anonym session och hemlig bearer-token. POST /api/sessions/:id/observations skickar ordnade batcher med token. Svaret innehåller kumulativ ACK och authoritative state. Klienten tar bara bort ACK:ade paket. Servern kräver sekventiell ordning; dubletter ignoreras. Mättid (performance.now relativt sessionstart) används, aldrig ankomsttid. Persistens sker i append-only JSONL per session, med återuppbyggnad efter omstart. Token lagras som SHA256, inte klartext. Lokalt utgående kö lagras i IndexedDB. Rå IMU skickas endast vid användarens export; 60 s ringbuffer och valbar full inspelning.

Position: olika Stationary/Walking/Running/Vehicle/ConservativeMotionModel. Servern väljer modell, uppskattar steglängd, integrerar försiktigt fordon under högst fem sekunder utan GPS, fusionerar godkända fixes och aggregerar trajectory/heatmap. GPS-korrigering ändrar position men räknas inte som fysisk förflyttning i TotalDistance. Trajectory skiljer correction från movement och metermarkörer följer endast movement. Confidence är heuristisk kvalitetsindikator, inte statistiskt kalibrerad sannolikhet.

Lokal karta och Google Maps får samma serverstate. Maps påverkar aldrig motorn. Geografisk förankring använder första godkända fixen och första tillförlitliga course från förflyttning; före detta visas bara lokal karta. Startens lokala riktning är alltid +Y. Ingen koppling mellan skärmens rotation och startens TravelHeading.

Gränssnitt uttrycks med JS-basklasser (ISensorSource, IMotionFeatureExtractor, IMotionClassifier, IGpsQualityEvaluator, IMapRenderer). Dessa kastar om abstrakta metoder används. Klientdelarna kan ersättas med ML utan att ändra observationsprotokollet.

Utan internet fungerar appskalet efter första laddning via service worker och sensorpipeline fortsätter buffra. **Authoritative position kräver kontakt med servern**, alternativt en server på lokalt LAN. UI visar senaste ACK:ade position som frusen vid nätverksbortfall. En mobil webbläsare kan pausa sensorer när skärmen släcks. Kör över HTTPS och behåll appen i förgrunden.

Säkerhet: same-origin API, per-session token, storleksgränser och strikt observationsvalidering. Prototypen har inga användarkonton eller åtkomstkontroll mellan organisationer. Vid drift: reverse proxy med HTTPS, företagsinloggning, rate limiting och retention-policy. Sessioner kan raderas i UI. .gitignore utesluter inspelningar och sessionsdata.
