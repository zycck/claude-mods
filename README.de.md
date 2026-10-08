# Mods für Claude Code

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · **Deutsch** · [Français](README.fr.md)

## plan-progress

Live-Fortschrittsbalken über dem Eingabefeld von Claude Code. Claude teilt eine Aufgabe in Phasen und Schritte, und der Balken füllt sich während der Arbeit. Die Subagenten jeder Aufgabe stehen unter ihrem Balken.

![plan-progress: zwei Aufgaben mit ihren Agenten, eine Frage, ein Fehler, ein unterwegs geänderter Plan, beide Aufgaben fertig](media/plan-progress.gif)

[Mit Ton ansehen (MP4, 14 s)](media/plan-progress.mp4)

- Eine Zeile pro Aufgabe: Status, Titel, Balken, Prozent, Schließen-Schaltfläche
- Das Label auf dem Balken zeigt die aktuelle Phase und den Schritt; beim Überfahren die bisherige Dauer
- Phasen sind Kapseln, Schritte Punkte; beim Überfahren erscheint, wann sie erreicht wurden
- Ein fertiger Balken wird grün und zeigt die Gesamtdauer und verschwindet nach 30 s von selbst (`doneBarSeconds` in `/config`)
- Vier Zustände: läuft, wartet auf Antwort, Fehler, fertig
- Jeder Subagent hat eine Zeile unter seiner Aufgabe: Name, Modell und Effort, aktuelles Tool, Dauer
- Der Plan kann sich unterwegs ändern; erledigte Schritte bleiben über ihren Titel erhalten
- Balken werden pro Sitzung gespeichert und beim Fortsetzen wiederhergestellt
- Kurze Töne bei einer Frage, einem Fehler und beim Abschluss
- Läuft in der Desktop-App und im Terminal
- Im Terminal folgt der Balken mit dem Theme `auto` dem hellen oder dunklen GNOME-Desktop und übernimmt die Farben des aktiven Omarchy-Themes

### Installation

Erfordert Claude Code 2.1.286 oder neuer (`claude --version`; aktualisieren mit `claude update`). In älteren Versionen lädt das Hooks-Modul nicht und es erscheinen keine Balken; beim Start steht `plan-progress: hooks module did not load`.

```
/plugin marketplace add zycck/claude-mods
/plugin install plan-progress@zycck-mods
```

Aktualisieren:

```
claude plugin marketplace update zycck-mods
claude plugin update plan-progress@zycck-mods
```

### Befehle

- `/progress` blendet die Balken ein oder aus
- `/progress-clear` entfernt alle Balken
- `/progress-agents` klappt die Agentenstreifen unter den Balken ein oder zeigt sie wieder (die Pfeil-Schaltfläche neben dem ✕ eines Balkens tut das für diesen Balken)
- `/plan-progress-autoclose` schaltet das automatische Schließen fertiger Balken aus oder wieder ein; die Wahl bleibt über Sitzungen erhalten

Die Schaltfläche **Progress** in der Fußzeile entspricht `/progress`.

### Funktionsweise

Der Mod registriert das Tool `plan_progress`. Claude sendet den Plan einmal und danach kurze Updates wie `{id, next: true}` oder `{id, done: ["Routes"]}`. Ein unbekannter Schrittname wird mit der Liste der Schritte des Balkens abgelehnt. Ein im Plan Mode genehmigter Plan wird zum Balken `plan`. Die Agentenzeilen stammen aus Engine-Ereignissen und kosten keine Tokens.

In der Desktop-App ist der Balken ein SVG-Bild mit einer Hover-Ebene darüber. Im Terminal ist er ein Zeichenraster, das nur animiert, solange Claude arbeitet.

### Tests

`plugins/plan-progress/tests` führt das echte Modul gegen eine Stub-Engine aus: `node compile.cjs ../hooks/register.tsx register.mjs`, danach `node regress.mjs` und `node scenarios.mjs`.

## Lizenz

MIT
