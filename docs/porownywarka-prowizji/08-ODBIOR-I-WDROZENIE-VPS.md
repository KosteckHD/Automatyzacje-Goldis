# P08 — odbiór i wdrożenie na VPS

Zależności: P01–P07. Efekt: moduł działa na Linux VPS w rzeczywistej konfiguracji usług, z odtwarzaniem, kontrolowanym wydaniem i możliwością wycofania. Plan nie uruchamia usług ani nie wdraża zmian na serwerze.

## 1. Zmiany infrastrukturalne

Do istniejących `compose.yaml` i `compose.production.yaml` dodać:

- `commission-engine`: obraz Python z pakietem silnika i prywatnym transportem.
- `commission-dispatcher`: proces Node z obrazu API albo osobnego obrazu z tym samym kodem, obsługujący kolejkę prowizji.
- Prywatną sieć `goldis_commissions`, do której należą dispatcher i Python. Python nie publikuje portu na hoście ani tras w publicznym reverse proxy.
- Sekret komunikacji wewnętrznej, ograniczone poświadczenia dispatchera do DB/Redis i dostęp do niezbędnego magazynu przez Node.
- Metadane obrazu, wersji silnika, health/readiness oraz skrypty startu i sprawdzania konfiguracji.

API nadal obsługuje klientów przez istniejący kanał HTTPS. Python nie dostaje kluczy bazy, Redis, szyfrowania artefaktów ani danych logowania do portali. Nie instalować Excela/LibreOffice jako warunku działania.

## 2. Budowanie obrazów

1. Wybrać jedną wspieraną wersję CPython, zweryfikować zgodność bibliotek na docelowej architekturze VPS i przypiąć obraz bazowy/digest.
2. Zapisać zależności w `pyproject.toml` i lockfile, z kontrolowanym odtwarzaniem i weryfikacją hashy. Budować je w CI, nie instalować z internetu przy każdym starcie.
3. Obraz zawiera tylko potrzebne moduły: odczyt, domenę, eksport i transport. Nie zawiera plików klienta, słownika prywatnego, tokenów i testowych wyników.
4. Uruchamiać jako użytkownik bez uprawnień root, z read-only root, ograniczonym `/tmp`, limitami procesów/pamięci/CPU, `no-new-privileges` i bez zbędnych capabilities.
5. Wdrożyć kontrolę wersji schematu na połączeniu Node/Python. Niezgodne obrazy nie przyjmują zadań jako pozornie gotowe.
6. Zapisać manifest wydania: commit, digest API/dispatchera/Pythona, wersję kontraktu i migracji. Słownik jest wersjonowaną daną organizacji, a nie sekretnie zaszytą częścią obrazu.

Dokumentacja [FastAPI w kontenerach](https://fastapi.tiangolo.com/deployment/docker/) jest punktem odniesienia transportu; limity i sposób nadzoru procesów wynikają z naszego kontraktu P06.

## 3. Sieć, uprawnienia i pliki

- Z internetu dostępny jest tylko zamierzony publiczny interfejs przez konfigurację Goldis; DB, Redis i Python nie mają publicznych portów.
- Dodać/ograniczyć rolę DB dispatchera do zadań i danych prowizyjnych przez zatwierdzone repozytoria/funkcje. Brak roli migratora i uprawnień DDL w runtime.
- Redis ACL musi obejmować tylko potrzebne komendy i przestrzeń kolejki prowizji. Nie zakładać, że obecne konto workera OC ma właściwy zakres.
- Sekrety podawać zgodnie z istniejącym mechanizmem secrets i plików konfiguracji. Nie wypisywać `.env` ani haseł w logach i raportach wdrożenia.
- Źródła i eksporty przechowywać zaszyfrowane; kopie robocze Pythona tylko na ograniczonym obszarze tymczasowym, sprzątane po zakończeniu lub śmierci procesu.
- Zachować existing deletion journal i blokady odtwarzania usuniętych danych, rozszerzając je o zasoby prowizyjne.

## 4. Ustalenie pojemności VPS

Nie znamy jeszcze parametrów docelowego serwera, więc plan nie deklaruje wymaganej konfiguracji zakupowej ani gwarantowanego czasu analizy. Pierwsza konfiguracja dopuszcza jedno równoczesne obliczenie prowizyjne. Limity usługi dobrać po pomiarach, uwzględniając PostgreSQL, API i działający moduł OC.

Pomiary wykonać dla:

1. Obecnego zestawu: 1678 polis CRM, 3977 wierszy rozliczeń, 653 wpisy słownika.
2. Większych syntetycznych zestawów, np. 10×, z zachowaniem kolizji i wielu ryzyk.
3. Dokumentu bliskiego limitowi rozmiaru oraz arkusza o niekorzystnym układzie/kompresji.
4. Kolejki kilku analiz, generowania raportu i równoległej zwykłej pracy w panelu.

Zmierzyć czas etapów i całości, szczyt RAM, CPU, `/tmp`, rozmiar odpowiedzi/raportu, tempo zapisu DB i opóźnienie panelu. Wyniki określają limity plików/wierszy i timeouty. Przekroczenie jest czytelnym błędem, nie cichym ucięciem danych. Nie zwiększać równoległości przez samo podniesienie liczby workerów HTTP.

## 5. Monitorowanie

Monitorować liczbę i wiek zadań oczekujących, aktywne próby, retry i stalled, dostępność Pythona, czasy parse/compare/export, użycie pamięci/tymczasowego dysku, błędy formatów i stan finalizacji eksportów.

Logi zawierają korelację job/run/execution, wersje, kody i zagregowane liczniki. Nie zawierają danych klientów, całych wierszy, numerów polis ani sekretów. Dane wymagające wyjaśnienia są dostępne w uprawnionym widoku wyniku, nie w publicznym stack trace.

## 6. Backup i odtworzenie

1. Rozszerzyć istniejący backup o tabele prowizyjne, wersje reguł, zaszyfrowane źródła i raporty oraz wymagane klucze według procedury Goldis.
2. Traktować kopię DB i plików jako spójny zakres. Zapisane w bazie metadane nie wystarczają bez źródeł i kluczy.
3. Dziennik usunięć zachować zgodnie z jego odrębną procedurą, aby restore nie przywrócił świadomie usuniętych zasobów.
4. Odtworzyć w izolowanym środowisku i sprawdzić: logowanie, prawa, stary wynik, pobranie starego raportu i nową analizę na odtworzonych danych.
5. Odtworzone zadanie nie może zostać uznane za nadal działające na nieistniejącym procesie; procedura odzyskania rozstrzyga lease i retry.

## 7. Procedura wydania

1. Zakończyć testy i parytet P01–P07; przygotować manifest obrazów i plan wycofania.
2. W środowisku testowym odtworzyć produkcyjną konfigurację Linux/Compose, bez kopiowania czynnych profili portali.
3. Zweryfikować migracje, role, sekrety, sieci, limity i kompatybilność usług.
4. W uzgodnionym oknie na VPS wykonać spójny backup i kontrolowane migracje.
5. Uruchomić zgodne obrazy z narzędziem początkowo niedostępnym dla zwykłych użytkowników.
6. Zaimportować prywatny słownik i zestaw odbiorowy przez kontrolowany proces. Nadać granty kontom pilotażowym.
7. Przeprowadzić odbiór porównania z v7 oraz przypadków awarii. Dopiero po zatwierdzeniu udostępnić narzędzie docelowym osobom.
8. Obserwować pierwsze rzeczywiste zadania i zapisać rezultat odbioru. Pusty status health nie zastępuje sprawdzenia wyniku.

Produkcji nie aktualizujemy w środku aktywnego zadania bez ustalonej polityki: zatrzymanie przyjęć i dokończenie albo kontrolowane anulowanie/retry. Nie podmieniamy w locie silnika przypiętego do analizy.

## 8. Wycofanie

- Najpierw wyłączyć nowe analizy dla modułu; historia i uprawnione pobieranie mogą pozostać dostępne.
- Dokończyć lub anulować aktywne próby, nie zostawiać ich jako działających.
- Przywrócić poprzednie, zgodne obrazy/konfigurację. Migracje projektować zgodnie z istniejącą procedurą zmian kompatybilnych; rollback nie powinien kasować wyników przez automatyczne `DROP`.
- W razie błędnej stawki przywrócić wcześniejszą aktywną wersję słownika dla nowych analiz, a błędne wyniki oznaczyć i przeliczyć jako nowe analizy.
- Nie odtwarzać całej bazy tylko po to, aby zmienić aktywny słownik.

## 9. Macierz odbioru końcowego

| Obszar | Warunek PASS |
| --- | --- |
| Zależności | Analiza i eksport działają na Linux bez Office, LibreOffice i lokalnego runtime Codex. |
| Parytet | 944 polis, 682/244/18, 1651/481, 257 na 140 polisach oraz zgodność pojedynczych pozycji. |
| Import | Jednostki, formuły, duplikaty, wymiary Warty i limity mają testy pozytywne i negatywne. |
| Wersje | Stary wynik nie zmienia się po edycji słownika ani wdrożeniu obrazu. |
| Dostęp | Brak odczytu/pobrania/edycji bez właściwego grantu i brak przekroczenia tenantów. |
| Awaria | Restart, utrata HTTP i ponowiona dostawa nie tworzą drugiego ani częściowego wyniku. |
| Anulowanie/usuwanie | Proces kończy się, a spóźniony wynik nie odtwarza danych. |
| Eksport | XLSX ma gotowe wartości, pełne numery i zgodność z zatwierdzonym snapshotem. |
| Odtworzenie | Backup odtworzony w izolacji daje dostęp do historii i plików z zachowaniem usunięć. |
| Regresja | Istniejące logowanie, uprawnienia, katalog i narzędzie OC zachowują działanie. |

Raport odbioru zapisuje wersję kodu/obrazów/schematu, środowisko, komendy, expected/actual i wynik każdego punktu: PASS, FAIL, SKIP albo BLOCKED. Pominięcie nie jest zaliczeniem.

## 10. Dane potrzebne przed rzeczywistym wdrożeniem

Do wykonania P08 będą potrzebne parametry i sposób dostępu do VPS, istniejąca domena/TLS, dostępna pamięć i dysk, polityka backupu oraz uzgodnione okno wydania. Ich brak nie blokuje przygotowania kodu i izolowanych testów P01–P07, ale blokuje potwierdzenie gotowości rzeczywistego serwera.
