# Qsys · Gångkarta

Mobilanpassad rörelsekarta som ritar gång med telefonens accelerometer, gyroskop och orientering. Kartberäkningen sker lokalt i webbläsaren. Appen begär inte GPS och skickar inte mätningen till servern.

## Användning

Öppna appen via HTTPS på telefonen. Loggningen börjar automatiskt. På telefoner som kräver ett tryck för sensorbehörighet visas **Tillåt sensorer**. Gå med telefonen riktad framåt. **Ny karta** rensar mätningen och sätter en ny startpunkt medan sensorerna fortsätter logga.

Steg räknas från tydliga accelerationstoppar med tillräcklig styrka, minst 60 ms uppbyggnad och minst 0,32 sekunder mellan steg. Signalen måste sjunka mellan topparna. Dessutom krävs tre regelbundna steg, återkommande gångmönster och horisontell acceleration med tillgänglig orientering. De första stegen ritas i efterhand med sina ursprungliga riktningar. Enbart vertikal telefonrörelse räknas inte. Detta är en heuristik, inte ett bevis på faktisk förflyttning. Innan kartan börjar ritas anges en känd sträcka i meter. Tryck Börja kalibrering, gå sträckan och välj Klar – börja rita. Steglängden blir sträckan dividerad med antal registrerade steg. Kalibreringsstegen ritar inget spår; kartan nollställs när kalibreringen avslutas. Ny karta behåller steglängden under samma sidbesök. Orange spår och rektangel visar referensen baserad på telefonens rotation. Grönt spår och pil använder gångmönstrets horisontella huvudaxel i navigationsramen för att uppskatta färdriktningen. Vid svagt gångmönster behålls senast uppskattade färdriktning. Riktningen har en 180-graders tvetydighet och är inte en verifierad markriktning. Detta är en sensorprototyp, inte uppmätt markposition.

Kartan har fast orientering med startens riktning uppåt. Autozoom visar hela spåret. Under **Felsökning** visas sensorernas status. Kartan ligger i minnet och försvinner vid omladdning.

## Lokal utveckling

Node.js 22 eller senare. Kör `npm install`, `npm run build`, `npm start` och öppna http://localhost:3000. Telefonens sensorer kräver HTTPS (localhost är undantaget). Kör `node --test tests/*.test.js` för verifiering.

`client/walking.js` är den aktiva gångberäkningen. `client/app.js` sköter sensorstart, presentation. `client/maps.js` ritar kartan. Gemensamma IMU-komponenter finns i `client/pipeline.js`.

Äldre servermotor, transportmodeller och tester finns kvar som tidigare implementation och används inte av gångkartans mätflöde. IIS-värden kan fortsätta servera statiska filer utan ändrade bindningar. `tools/publish-client-iis.ps1` publicerar klienten och stämplar senaste commitdatumet.

## Sensorhistorik

Under Felsökning finns Exportera all sensorhistorik och Markera avvikelse. JSON-filen innehåller rådata, separata orienteringshändelser, beräknade riktningar och gångfunktioner, steg, kalibrering, båda spåren, sensorstatus, commitversion och aktuell kartbild. Ny karta tömmer sensorhistorik, tidigare segment och avvikelsemarkeringar. Därefter omfattar både lokal export och serversparande endast data från senaste Ny karta. Kalibrerad steglängd behålls. Exportera innan omladdning; historiken ligger i minnet. Ingen automatisk uppladdning sker.

Knappen Spara till fil på servern vid kartan sparar sensorhistoriken sedan senaste Ny karta och aktuell kartbild i DATA_DIR/sensor-history. Ange ett testnamn, t.ex. gangkarta-uppratt-telefon. Filens nedladdningsnamn får Stockholm-datum, klockslag och ett unikt suffix. En svårgissad nedladdningslänk returneras; ingen offentlig fillista finns. Max 25 MB per uppladdning. Vid större filer finns lokal export. Backendändringar publiceras med publish-client-iis.ps1 -IncludeServer, vilket återstartar app-poolen och bevarar IIS-bindningar.

Grön riktning stabiliseras över flera gångfönster. Små ändringar av accelerationsaxeln vrider inte spåret. En sväng kräver stöd från både relativ telefonrotation och ändrad gångaxel; rotationshistoriken löser 180-gradersvalet. När en sväng bekräftas räknas berörda gröna steg om från svängens början. Orange beräkning och stegräkning är oförändrade. Kvalitetsstatusen är en heuristisk indikator, ingen validerad sannolikhet.

Svängdetekteringen fryser referensen vid påbörjad rotation och stöder även partiella och långsamma svängar. Svängar avslutas när rotationen stabiliserats med stöd av gångaxeln, med en 12-sekunders reservgräns från upptäckten. Efterhandskorrigering börjar vid rotationens upptäckta början. Orange referens ändras inte.

Efter praktiskt test har den gröna TravelDirection återställts till ae22a4e. Senare nollställning av sensorhistorik och exportfunktioner är kvar. Orange referens är oförändrad.

Efter en bekräftad sväng kan stabil gång korrigera kvarstående grön vinkelskillnad. Referensen lärs under stabil gång före första svängen. Efter svängen krävs minst åtta starka gångfönster över en sekund med liten axelspridning. Korrigeringen begränsas till fem grader per sekund, avvisar skillnader över 45 grader och ändrar inte orange referens eller tidigare steg.

Green follows the same phone heading as orange, minus a continuous mounting offset. Navigation-frame gait estimates changes to that offset only after repeated stable gait windows (at least 1.5 seconds of evidence). The provisional recent route and derived headings are then corrected retrospectively, including the grip transition. Offset, pending evidence and corrections are exported for diagnostics. Weak or ambiguous gait leaves the phone-based route provisional; a 180-degree acceleration axis cannot by itself distinguish every phone reversal from a body U-turn. Orange and numbered orange markers are unchanged. Real walking tests are still necessary.
