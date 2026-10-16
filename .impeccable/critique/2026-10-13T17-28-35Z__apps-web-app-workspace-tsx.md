---
target: "landing page Goldis: logowanie i pierwsze wejście do OC"
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\micha\\Desktop\\Goldis-Automatyzacje\\apps\\web\\app\\workspace.tsx"
target_fingerprint: "sha256:080d6e0286a121a7667e9f1c9696ecbece0426a1e29f9a20c521dcc826d33ded"
target_path: "C:\\Users\\micha\\Desktop\\Goldis-Automatyzacje\\apps\\web\\app\\workspace.tsx"
timestamp: 2026-10-13T17-28-35Z
slug: apps-web-app-workspace-tsx
---
Method: dual-agent (A: /root/design_review · B: /root/technical_evidence)

**Landing page: 7,3/10. Cała ścieżka do pierwszej czynności: 6,8/10.**

Audyt dotyczy strony wejściowej Goldis: logowania oraz przejścia do Przeglądu, katalogu i pierwszego importu OC. To ocena heurystyczna, bez pomiaru rzeczywistej konwersji.

| Obszar | Logowanie | Logowanie → pierwsza czynność |
|---|---:|---:|
| UI | **8/10** | **7,5/10** |
| UX | **7/10** | **6,5/10** |
| User flow | **7/10** | **6,5/10** |

**Wygląd ma spójną tożsamość.** Oficjalne logo, czerń, złoto i kremowa typografia tworzą rozpoznawalną markę. Największy potencjał poprawy leży w obsłudze błędów i doprowadzeniu użytkownika do działania.

**Co działa**

- Czytelny formularz: dwa opisane pola, autouzupełnianie i jedna główna akcja. Na ekranie 390×844 px przycisk logowania jest widoczny bez przewijania.
- Przegląd ma bezpośredni przycisk „Przygotuj import OC”. Katalog nie jest obowiązkowym dodatkowym krokiem.
- Brak poziomego przewijania przy 320, 390 i 1440 px. Widoczny fokus formularza; menu mobilne obsługuje Escape i przywraca fokus.

**Najważniejsze poprawki**

1. **[P1] Pierwsza czynność w narzędziu OC znajduje się zbyt nisko.** Przy szerokości 390 px wybór pliku zaczyna się około **1184 px od góry**, przy 320 px około **1348 px**. Przed nim są opis, status, trzy kroki i pusty blok zgłoszeń. Użytkownik musi szukać działania, które właśnie wybrał. Przenieść import wyżej i zwinąć puste zgłoszenia. [Miejsce w kodzie](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/workspace.tsx:1055). Polecenia: impeccable adapt / layout.

2. **[P2] Awaria logowania wygląda jak błędne hasło.** Testowa odpowiedź HTTP 503 wyświetla „Sprawdź login i hasło”. To skłania do bezcelowych prób i podważa zaufanie. Rozdzielić błędne dane, awarię usługi i ograniczenie prób; dodać jasny następny krok. Pomoc w odzyskaniu dostępu powinna wskazywać konkretny kanał kontaktu. [Miejsce w kodzie](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/workspace.tsx:915). Polecenie: impeccable harden.

3. **[P2] Katalog myli błąd pobierania z brakiem uprawnień.** Przy HTTP 503 pokazuje jednocześnie błąd i „Brak dostępnych narzędzi”, z sugestią czekania na dostęp od administratora. Rozdzielić stany ładowania, błędu, pustego katalogu i gotowych danych; w błędzie dodać „Spróbuj ponownie”. [Miejsce w kodzie](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/tools/tool-catalog.tsx:32). Polecenie: impeccable harden.

4. **[P2] Nazwa zadania i język zmieniają się po drodze.** „Przygotuj import OC” → „Weryfikacja polis OC” → „Weryfikacja danych transportowych”. Dochodzą „worker Playwright”, „selektory ekranów” i techniczny identyfikator modułu. Utrzymać nazwę „Weryfikacja polis OC”, a bazę transportową opisać jako dane wejściowe. Status powinien wyjaśniać dostępność i następny krok; diagnozę techniczną przenieść do szczegółów administracyjnych. Stała karta wymagań nie powinna sugerować niegotowości przy komunikacie „Automatyzacja gotowa”. [Miejsce w kodzie](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/workspace.tsx:1074). Polecenie: impeccable clarify.

5. **[P1] Drobny tekst po zalogowaniu wymaga poprawy kontrastu.** Etykiety „PRACA/KONTO” mają **4,44:1** przy około 10 px; minimum dla zwykłego tekstu wynosi 4,5:1. Samo logowanie wypada dobrze: pomoc **7,46:1**, przycisk **9,59:1**. Rozjaśnić kolor etykiet i usunąć kolizję stylów szczegółu gotowości usług, dla którego kontrast obliczony ze źródła wynosi około 3,86:1. [Miejsce w kodzie](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/leads/leads.css:27). [Podstawa: WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Polecenie: impeccable colorize.

**User flow**

Obecnie: logowanie → Przegląd → „Przygotuj import OC” → opis/status/kroki/puste zgłoszenia → wybór pliku.

Docelowo: logowanie → Przegląd → „Przygotuj import OC” → widoczny wybór pliku, wymagania i aktualny status.

Logowanie ma małe obciążenie poznawcze. W Przeglądzie osiem pozycji w grupie „PRACA” i powtarzające się skróty zwiększają liczbę wyborów, choć główny przycisk pomaga. Na wejściu do OC problemem jest kolejność informacji. Nowy pracownik traci pewność przez zmieniające się nazwy i mylące błędy; użytkownik mobilny musi przewijać, a stały operator omija puste komunikaty.

**Heurystyki Nielsena — cała oceniana ścieżka**

| Heurystyka | /4 | Główna obserwacja |
|---|---:|---|
| Widoczność statusu | 3 | Statusy są, stałe wymagania osłabiają jasność gotowości |
| Język użytkownika | 3 | Techniczny żargon na wejściu do OC |
| Kontrola i swoboda | 3 | Działająca nawigacja i zamykanie menu |
| Spójność | 2 | Zmieniające się nazwy |
| Zapobieganie błędom | 3 | Wymagane pola i zablokowany pusty import |
| Rozpoznawanie zamiast pamiętania | 3 | Etykiety i kroki procesu |
| Efektywność | 2 | Dobry skrót do OC, zbędne treści przed importem |
| Estetyka i minimalizm | 3 | Spójna marka, pusty panel przed główną akcją |
| Odzyskiwanie po błędach | 2 | Mylące komunikaty, brak ponowienia katalogu |
| Pomoc | 1 | Kontakt opisany bez konkretnego kanału |
| **Suma** | **25/40** | Ocena heurystyczna całej ścieżki |

Technicznie: **14/20** — dostępność 3/4, wydajność 3/4, responsywność 3/4, system kolorów 2/4, spójność implementacji 3/4. Wydajność oceniona w ograniczonym zakresie, bez benchmarku produkcji.

Mniejsze poprawki: ujednolicić mobilne pola dotykowe do około 44 px (część przycisków ma 42–43 px, linki pomocnicze około 18 px wysokości); doprecyzować ogólny nagłówek „Narzędzia dla pracy z danymi”. Zalecenie 44 px dotyczy wygody — nie oznacza automatycznie naruszenia minimum WCAG, które ma osobne wyjątki. [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

Automatyczny detektor zwrócił **0 ostrzeżeń**; opisane problemy wynikają z obserwacji przeglądarki i kodu. Sprawdzono ekran rzeczywisty i izolowane stany z testowymi odpowiedziami API. Nie używano prawdziwych kont ani nie uruchamiano importu. Telefon emulowano w Chromium; test na fizycznym urządzeniu pozostaje poza zakresem.

Po poprawkach: impeccable polish i ponowny audyt. Można wdrożyć poprawki pojedynczo lub w ustalonym zakresie.

Pytania do ustalenia dalszych prac:
- Priorytet: A — wejście do importu na mobile; B — obsługa błędów; C — nazwy i komunikaty?
- Zakres: A — trzy najważniejsze poprawki; B — wszystkie wskazane poprawki?
