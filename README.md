# Sticky Note Lab

Sticky Note Lab verwandelt ein Foto eines Haftnotiz-Boards in ein editierbares digitales Board. Die Verarbeitung läuft lokal im Browser: Notizen werden erkannt, perspektivisch vermessen, per OCR gelesen und anschließend als verschiebbare Objekte dargestellt.

![Sticky Note Lab](public/og.png)

## Funktionen

- farb- und kantenbasierte Erkennung von Haftnotizen
- Rekonstruktion teilweise überlappter und gedrehter Notizen
- perspektivisch entzerrte Mehrfach-OCR mit PaddleOCR, DE·HTR und Tesseract
- Erkennung einfacher Symbole wie Herz, Pfeile, Ausrufezeichen und Smileys
- editierbare Texte, Farben, Größen und Positionen
- Ansicht **Wie im Foto** mit Drehung und Überlappung
- Ansicht **Sortiert** mit geraden, kollisionsfreien Notizen
- Verbindungen zwischen Notizen und Export des Boards
- keine Übertragung des Board-Fotos an einen Server

## Technisch passiert dabei Folgendes

- Das Foto wird vollständig lokal im Browser dekodiert – es wird nirgendwo hochgeladen.
- Farben werden im wahrnehmungsnahen Lab-Farbraum gruppiert. Zusätzlich werden Kanten, Rechtecke und sichtbare Papierfragmente untersucht.
- Bei Überlappungen versucht die Geometrie, verdeckte Ecken zu ergänzen und zu bestimmen, welcher Zettel vorne liegt.
- Aus den vier erkannten Ecken wird per perspektivischer Transformation ein gerader Ausschnitt berechnet – ähnlich wie bei einem Dokumentenscanner.
- Von jedem Ausschnitt entstehen mehrere Varianten: Farbe, Graustufen, Schattenausgleich, Kontrastverstärkung, Sauvola-Schwarzweiß und eine „nur Tinte“-Maske.
- Textzeilen werden einzeln gesucht und zusätzlich als komplette Notiz gelesen.
- Drei unterschiedliche Leser arbeiten zusammen:
  - PaddleOCR als Hauptleser
  - DE·HTR speziell für Handschrift
  - Tesseract als unabhängiger Fallback
- Die Ergebnisse werden nicht einfach blind übernommen. Die Anwendung vergleicht vollständige Texte, einzelne Zeilen, Filtervarianten und unabhängige OCR-Engines. Erst danach wird ein Ergebnis ausgewählt.
- Wörterbücher dürfen nur relativ sichere Tipp- und OCR-Fehler korrigieren, statt beliebige Wörter zu erfinden.
- Herzen, Pfeile, Smileys und Ausrufezeichen laufen über eine separate Formanalyse, weil normale OCR solche Zeichnungen oft als `11`, `V` oder Buchstaben interpretiert.
- Am Ende werden Position, Größe, Drehung, Farbe, Ebenenreihenfolge und Text in React-Zustand überführt. Dadurch ist jede Notiz verschiebbar und editierbar.
- Die sortierte Ansicht berechnet zusätzlich ein kollisionsfreies Raster, ohne die ursprüngliche Fotoanordnung zu zerstören.

Der langsame erste Durchlauf kommt hauptsächlich daher, dass etwa **192 MB lokale OCR-Modelle** geladen, entpackt und für WebAssembly beziehungsweise ONNX vorbereitet werden. Danach laufen die Berechnungen direkt auf deinem Gerät.

Sticky Note Lab kombiniert Computer Vision, mehrere neuronale OCR-Modelle, klassische Bildverarbeitung, geometrische Rekonstruktion und einen grafischen Editor.

## Voraussetzungen

- Node.js `>=22.13.0`
- [pnpm](https://pnpm.io/)
- [Git LFS](https://git-lfs.com/) für die lokalen OCR-Modelle

## Installation

```bash
git lfs install
pnpm install
pnpm dev
```

Die Entwicklungsseite läuft anschließend auf der vom Terminal ausgegebenen lokalen Adresse.

## Im lokalen Netzwerk starten

```bash
pnpm build
pnpm start --host 0.0.0.0 --port 3003
```

Andere Geräte im selben WLAN öffnen danach `http://<IP-des-Rechners>:3003`. Falls die Verbindung blockiert wird, muss Node.js für private Netzwerke in der lokalen Firewall freigegeben sein.

## Qualitätssicherung

```bash
pnpm test
pnpm run lint
```

Die Tests prüfen unter anderem perspektivische Geometrie, überlappende Notizen, OCR-Fusion, Textkorrektur, Symbolerkennung, Modell-Assets und den Produktions-Build. Das Repository enthält bewusst keine fremden Board-Fotos; Bildtests verwenden ausschließlich synthetische Testdaten.

## Projektstruktur

- `app/` – Oberfläche sowie Erkennungs-, OCR- und Boardlogik
- `public/ocr-models/` – lokale OCR-Modelle
- `public/onnx*/`, `public/tesseract*/` – lokale Browser-Runtimes
- `tests/` – Unit-, Foto-, Asset- und Rendering-Tests
- `.openai/hosting.json` – optionale Sites-Konfiguration

## Datenschutz und Lizenzhinweise

Fotos bleiben im Browser und werden nicht hochgeladen. Die mitgelieferten Drittanbieter-Modelle, Wörterbücher und OCR-Runtimes behalten ihre jeweiligen Lizenzen; eine Übersicht mit Quellen, Versionen, Prüfsummen und lokalen Lizenzpfaden steht in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Dieses Repository enthält derzeit keine allgemeine Open-Source-Lizenz und ist als privates Experiment gedacht.
