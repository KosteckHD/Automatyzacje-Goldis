# Gabinet Goldis — podgląd projektu

To osobny prototyp wizualny. Pokazuje siedem przykładowych układów z oryginalnym logo i lokalnymi fontami. Dane są demonstracyjne; formularze nie wysyłają żądań do aplikacji. Nawigacja i przełączniki pozwalają obejrzeć warianty. Spotlight w prototypie jest demonstracją CSS; produkcyjny frontend używa wybranych komponentów React Bits w `apps/web/components/react-bits`.

Pełny plan: [PLAN_FRONTEND_CZARNO_ZLOTY.md](../../PLAN_FRONTEND_CZARNO_ZLOTY.md).

```powershell
node docs/design/goldis/serve.cjs
# otwórz http://127.0.0.1:3445
```

Przełączaj widoki paskiem podglądu. Menu po lewej pokazuje docelową nawigację. Parametr `?screen=operations` otwiera konkretny widok; `&capture=1` ukrywa pasek podglądu na screenshotach.

```powershell
node docs/design/goldis/render.cjs
```

Renderer wymaga uruchomionego serwera i istniejącego Playwright w repozytorium. Zapisuje 7 desktopowych oraz 3 mobilne PNG. Sprawdza ładowanie fontów, błędy JS i poziomy overflow przy 320 px. W ograniczonym sandboxie Windows przechwytywanie obrazu Chromium może wymagać dodatkowych uprawnień.

Aktualne zrzuty aplikacji są w `implemented/`: logowanie desktop i mobile, przestrzeń pracy desktop i mobile (w tym otwarte menu) oraz administracja desktop i mobile. Wykorzystują wyłącznie dane syntetyczne przechwycone przez UI smoke; nie zawierają danych produkcyjnych.

Fonty pochodzą z oficjalnego repozytorium Google Fonts; pliki OFL leżą obok nich. JPG jest niezmienioną kopią logo użytkownika; CSS usuwa z widocznego kadru tylko puste marginesy. Warianty produkcyjne wymagają testu wszystkich stanów i danych z rzeczywistego API, zgodnie z planem.
