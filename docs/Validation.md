# Validering, 2026-10-08

## Automatiskt

Build: syntaxkontroll av samtliga egna JS-moduler och existenskontroll av nödvändiga webbassets. Inget transpileringssteg behövs.

33 MSTest-scenarier driver samma produktions-JavaScript via Node. Node-sviten omfattar samma 33 scenarier plus API-test med HTTP, sessiontoken, omsänd batch, batch-rollback vid sekvensgap, validering och serveromstart med återställd historik. Testnamn och körinstruktioner finns i README.

Scenarier inkluderar 180° vändning + retur, 360° stilla rotation, porträtt/landskap, isolerad skakning, bord/pickup, gångsväng, temporal mode-växling, GPS-kvalitetsövergångar och hopp, GPS-korrektionsbegränsning, WGS84 roundtrip, separata running/walking-modeller, heatmap-tid/segment och deterministisk replay.

Tester bevisar dessa kodinvarianter på syntetiska observationer. De bevisar **inte** precision eller generell transportklassificering på riktiga människor/fordon. Porträtt/landskap-testet verifierar initial nollriktning, inte samma gångnoggrannhet i alla hållpositioner. Periodisk handskakning kräver separat fälttest.

## Browser

Kontrollerad lokal demo med komplett sensorpipeline → HTTP → serverposition → canvas-karta, heatmap och händelselogg. Inga konsolfel i den kontrollerade demosessionen. GPS/IMU-hårdvara och extern Google Maps med riktig API-nyckel kan inte verifieras på denna stationära miljö. Lokalt fallback-läge verifieras vid val av Google Maps utan geografiskt ankare. Responsiv mobilvy granskas separat.

## Benchmark

Demo: 56 bekräftade syntetiska steg. Ingen fysisk ground truth finns, så transport accuracy, heading error och distance error redovisas inte som uppmätta. Utgående observations-JSON cirka 3,26 kB/s; protokoll-, HTTP- och svarstrafik tillkommer. Exakt resultat kan återskapas med `node tools/replay.mjs --demo demo-result.json`.

Rapporten i UI/CLI använder märkt aktivitet för tidsviktad accuracy, felaktiga övergångar, steg under märkt stillastående, count error när kända steg finns, heading error när känd kurs finns, kumulativ distance error, närmaste tidsstämplade endpoint och trajectory RMSE vid kända positioner samt verkligt antal GPS-fusioner. Glesa truth-markeringar ger gles utvärdering; trajectory RMSE är över truth-punkter, inte hela den kontinuerliga banan. Inga saknade värden fylls med påhittade procenttal.
