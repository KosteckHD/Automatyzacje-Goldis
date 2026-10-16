# Plany implementacji punktów 1–7

Data: 8 października 2026. Siedem osobnych instrukcji implementacji rozwija [plan ostatecznego domknięcia](../PLAN_OSTATECZNEGO_DOMKNIECIA_PLATFORMY_2026_10_08.md). Numeracja odpowiada siedmiu punktom przedstawionym użytkownikowi, a nie numeracji pakietów P00–P13 w dokumencie nadrzędnym.

| Punkt | Osobny plan | Zakres |
| --- | --- | --- |
| 1 | [Fundamenty techniczne](01-FUNDAMENTY-TECHNICZNE.md) | Izolacja testów, migracje, sesje, DB/Redis, kontrakty i dowody. |
| 2 | [Admin i Menedżer](02-ADMIN-I-MENEDZER.md) | Rola, granty, zakres danych, interwencje i UI uprawnień. |
| 3 | [Przygotowanie Excela](03-PRZYGOTOWANIE-EXCELA.md) | Parser, normalizacja, REGON, dwie deduplikacje, pacing i wersjonowane dane. |
| 4 | [Cały zestaw i paczki](04-CALY-ZESTAW-I-PACZKI.md) | Zamrożenie danych, paczkowanie, idempotencja, outbox i odzyskanie. |
| 5 | [Typy podmiotów i niezawodność portali](05-PODMIOTY-I-NIEZAWODNOSC-PORTALI.md) | Kontrakty tożsamości, adaptery, odzyskanie sprawy, lease i akcje niepewne. |
| 6 | [Obsługa przez panel](06-SMS-KOREKTY-I-STEROWANIE.md) | SMS, przydziały, korekty, pauza/wznowienie/anulowanie i czytelne stany. |
| 7 | [Wyniki, eksporty i usuwanie](07-WYNIKI-EKSPORTY-I-USUWANIE.md) | Snapshoty, raporty, pliki, purge, ochrona przed odtworzeniem danych. |

Łącznie: **99 kroków implementacji i 65 kryteriów odbioru**. Liczby opisują zakres planów, nie wykonane zadania. Każdy dokument zawiera założenia, mapę istniejącego kodu, proponowane kontrakty/model/API, numerowaną kolejność prac, macierz odbioru, testy i zależności.

## Wspólne ustalenia

- Jedna organizacja, maksymalnie pięciu użytkowników. Liczba podmiotów w pliku nie jest ograniczona do jednej firmy dziennie.
- Przetwarzamy cały zaakceptowany Excel i wszystkie wymagane typy podmiotów. Każdy wiersz ma rozliczenie, także przy pominięciu lub duplikacie.
- Brak REGON i NIP oznacza pominięcie rekordu. Poprawny NIP pozwala szukać REGON przez API. Niepewne dopasowanie wymaga weryfikacji.
- Duplikat jest usuwany z zestawu roboczego, z zachowaniem mapy do reprezentanta. Oryginalny import pozostaje do świadomego usunięcia.
- Admin i Menedżer obsługują SMS i interwencje przez panel. Ręczny SMS jest docelowym elementem produktu.
- Dane biznesowe przechowujemy do usunięcia przez uprawnioną osobę. TTL cache i rotacja backupu mają inne zadania.
- Wszystkie opisane nowe modele, endpointy, nazwy plików i statusy są **propozycją implementacji**. Ustalenia oznaczone jako istniejące wynikają z przeglądu kodu. Przed zmianą ponownie sprawdzić rzeczywisty stan repozytorium.

## Zależności i kolejność

1. Zaliczyć punkt 1. Przy jego realizacji spisać kontrakty punktów 3–7 i model usuwania.
2. Wdrożyć punkt 2 jako bazę autoryzacji dla kolejnych funkcji.
3. Wdrożyć punkt 3, następnie punkt 4. Już podczas punktu 1 rozpoznać możliwości portali z punktu 5; nie odkładać weryfikacji ścieżki spółki na koniec.
4. Wdrożyć punkt 5 oraz backend sterowania z punktu 6; UI może korzystać z ustalonych kontraktów. Pauza i kasowanie wymagają wspólnej kontroli wykonania.
5. Wdrożyć punkt 7; jego kontrakty i blokady zapisów projektować od początku, razem z przygotowaniem i dispatcherem.
6. Po zaliczeniu planów 1–7 odbieramy kompletny start lokalny (web/API/PostgreSQL/Redis/workery), migrację świeżej bazy, backup/restore oraz zatwierdzony lokalny proces. **To jest bieżąca bramka ukończenia.** VPS, domena, HTTPS i monitoring serwera są osobnym, późniejszym etapem i nie blokują lokalnego wydania.

## Procedura dla każdego kroku

1. Ustalić wejście, wyjście, uprawnienia, stany awarii i punkt trwałego zapisu; przeczytać istniejący kod i testy.
2. Dla nowej funkcji lub błędu o istotnych skutkach dodać test wykazujący wymagane zachowanie; nie tworzyć testów kopiujących implementację ani testów kosmetycznych zmian.
3. Zmienić najmniejszy spójny zakres. Numery migracji nadać z aktualnego stanu; podczas przeglądu kod kończył się na 033. Nie rezerwować numerów w dokumentach i nie edytować zastosowanych historycznych migracji.
4. Tenant, actor, rola i granty pochodzą z bieżącej sesji. Scope stosować przed liczeniem/paginacją. Dane domenowe i audyt zapisywać atomowo; I/O dostawcy pozostaje poza długą transakcją.
5. Po oczekiwaniu sprawdzić wersję danych, uprawnienia, usuwanie i lease. Wspólna kolejność blokad: użytkownik/członkostwo, import/przygotowanie/zestaw, run, zależności; dla wielu ID sortowanie deterministyczne. Zweryfikować zgodność z istniejącym mechanizmem blokad przed wdrożeniem.
6. Uruchomić testy właściwego modułu i dotkniętych kontraktów, potem wymagany build. Zachować dowody wersji, komendy i wyników.
7. UI sprawdzić przy 320/768/1920 px, klawiaturze, pustych danych, utracie sieci i spóźnionej odpowiedzi. Przed pisaniem kodu Next przeczytać [AGENTS.md](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/AGENTS.md) i odpowiednią lokalną dokumentację Next.

## Granice testów i odbioru

Zgodnie z wcześniejszym ustaleniem użytkownika nie tworzyć ani nie uruchamiać pełnego testu import → rejestr → portale → eksport. Każdy moduł otrzymuje syntetyczne wejście i kończy się na swoim kontrakcie. Dispatch ma kontrolowany odbiornik, eksport gotowy snapshot, adaptery lokalne strony fixture oraz osobny profil. Dziedziczone flagi live i pełnego flow są wyłączone. Istniejące komendy pełnego procesu pozostają poza automatyczną listą.

Nie testować na działającej bazie użytkownika, jego Redis ani profilu portalu. Moduły i lokalny runtime odbierać na izolowanej bazie/Redis i syntetycznych fixture. Każde użycie realnego konta, wysłanie SMS-u lub wykonanie skutku na portalu wymaga odrębnie uzgodnionego testu użytkownika. Brak VPS nie blokuje lokalnego domknięcia; klucz GUS jest potrzebny dopiero do rzeczywistego lookupu, a nie do testów adaptera.

Każdy plan posiada kryteria odbioru. Oznaczenia: `PASS`, `FAIL`, `SKIP`, `BLOCKED`; pominięcie nie jest zaliczeniem. Raport odbioru zawiera wersję/build/schema, środowisko, komendy, expected/actual, logi, ewentualne screenshoty i cleanup. Bieżący stan implementacji i wyniki testów są prowadzone w [raporcie wdrożenia](../STATUS_WDROZENIA_PLANOW_1-7_2026-10-08.md); status z tego raportu ma pierwszeństwo przed historycznym opisem wejścia w poszczególnych planach.
