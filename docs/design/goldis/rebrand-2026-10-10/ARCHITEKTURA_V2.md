# Goldis — propozycja architektury UI/UX, wersja 2

Data: 10 października 2026. Status: propozycja do omówienia; nie jest zatwierdzoną zmianą uprawnień ani wdrożeniem. Dotychczasowe plansze służą jako odniesienie wizualne, nie jako docelowa mapa stron.

## Potwierdzone założenia użytkownika

- Mały zespół: użytkownicy/pracownicy, menedżerowie i administrator.
- Główna rola w doświadczeniu produktu to użytkownik.
- Dashboard po zalogowaniu: ostatnie operacje, szybki dostęp do narzędzi i wyników.
- Boczna nawigacja do sekcji platformy.
- Osobna sekcja wyników: nazwa automatyzacji i ID; wynik dostępny także bezpośrednio po ukończeniu automatyzacji.
- Zachowanie logo Goldis i czarno-złotej kolorystyki.

## Źródła i obecne granice

Aktualna polityka kodu ma role admin, manager, operator, reviewer, auditor. Operator jest odpowiednikiem użytkownika wykonującego pracę. Reviewer i auditor pozostają wspierani, ale nie stanowią osobnych głównych person przy obecnym briefie.

Podstawa: apps/api/src/authorization-policy.ts, resource-scope.ts, authorization-guard.ts, tool-access.ts, admin.ts, session.ts, run-submissions.ts, history.ts oraz migracje 032 i 034. Starsza instrukcja administratora nie obejmuje wszystkich aktualnych zmian; rozbieżności nie stanowią zgody na zmianę polityki.

| Główna persona | Obecny zakres | Konsekwencja dla UI |
|---|---|---|
| Użytkownik / operator | Własne importy, zadania i wyniki w zakresie grantów; wyjątki dotyczą m.in. przydzielonego SMS | Szybkie uruchamianie, powrót do własnej pracy, wyniki i przypisane czynności |
| Menedżer | Operacje i dane organizacji w zakresie grantów do narzędzi; decyzje korekt i konfliktów; bez zarządzania kontami i ustawieniami admina | Ten sam interfejs pracy, szersze listy i filtry autora, kolejka decyzji |
| Administrator | Dane organizacji oraz konta, granty, sesje, przydział interwencji, ustawienia, monitoring i raporty | Ten sam obszar pracy plus oddzielna Administracja |

Przydział interwencji i istniejące raporty administracyjne są obecnie funkcjami admina. Udostępnienie ich menedżerowi wymaga osobnej decyzji i zmiany API, nie samego przycisku.

Granty są niezależne od roli: widoczność, uruchamianie, odczyt wyników, pobieranie. Migracja 032 rozdzieliła pobieranie od odczytu; nie wolno wymuszać dawnej implikacji w nowym frontendzie. Widoczność nie oznacza prawa do danych. Usuwanie to osobne prawo admina albo aktywnego menedżera z nadanym grantem.

## Docelowa nawigacja główna

| Pozycja | Cel | Warunek / zakres |
|---|---|---|
| Dashboard | Kontynuuj pracę, zobacz gotowe wyniki i potrzebne działania | Widżety i liczniki wyłącznie z dostępnego zakresu |
| Narzędzia | Wybierz dostępne narzędzie i rozpocznij pracę | Widoczność narzędzia; akcje zgodne z rolą i grantami |
| Zadania | Wszystkie dostępne uruchomienia, także zakończone; partie i szczegóły | Autoryzowany zakres danych; nie tworzyć osobnej Historii o tej samej zawartości |
| Wyniki | Znajdź gotowy rezultat i pobierz dostępny plik | Odczyt; pobieranie sprawdzane osobno |
| Do obsługi | SMS, wymagane dane, korekty i konflikty, które dana osoba może obsłużyć | Odpowiedni rodzaj czynności, rola, grant i przydział; licznik pilnych spraw |

Administracja tylko dla admina. Moje konto i wylogowanie w menu profilu. Audyt jako jeden współdzielony widok z filtrowanym zakresem; admin dociera z Administracji, menedżer i reviewer z dostępnego skrótu, auditor ma uproszczoną nawigację Audyt / Moje konto.

Nie dublować pozycji Moje konto i Ustawienia. Nie tworzyć oddzielnych pozycji Rejestr, NIP → REGON, Przygotowanie ani SMS w głównym menu: są częściami procesu.

## Dashboard zależny od roli

- Użytkownik: Szybki dostęp, Kontynuuj pracę, Wymaga mojej uwagi, Ostatnie wyniki, Ostatnie zadania. Główny przycisk Uruchom narzędzie tylko przy prawie wykonania.
- Menedżer: te same obszary z zakresem organizacji w dostępnych narzędziach; widoczne autorzy, filtry osoby i kolejka decyzji. Nie pokazywać wykresów finansowych ani administracyjnych raportów bez właściwego API.
- Admin: dashboard pracy z dodatkowym skrótem Administracja i krótkim komunikatem o awarii wpływającej na pracę. Pełne dane techniczne w Monitoringu.
- Tylko odczyt: wyniki i zadania bez przycisków startu/importu. Brak praw do wyników: bez tabel i liczników danych biznesowych. SMS może wymagać ograniczonego widoku nawet bez prawa odczytu wyników.
- Brak grantów: zrozumiały pusty stan z informacją o kontakcie z administratorem i dostępem do własnego konta.

## Model pracy i nazewnictwo

Narzędzie → import → przygotowanie danych → uruchomienie partii → zadania firm → wyniki.

- Narzędzie: moduł, obecnie Weryfikacja polis OC.
- Import: zachowany plik źródłowy i jego rekordy.
- Przygotowanie: korekty, ustalenie REGON, walidacja, grupowanie i deduplikacja; wartości źródłowe i operacyjne pozostają rozdzielone.
- Partia: zestaw rekordów przekazany do uruchomienia; odpowiada submission. Przy pojedynczym uruchomieniu UI nie musi eksponować technicznej złożoności partii.
- Zadanie: weryfikacja konkretnego podmiotu. Źródłowe rekordy mogą wskazywać wspólne zadanie; nie obiecywać relacji jeden wiersz = jedno nowe zadanie.
- Wynik: rezultat zadania. Gotowy wynik nie zawsze oznacza plik; brak pasujących polis jest poprawnym rezultatem, a nie błędem.

W języku użytkownika używać Partia, Zadanie, Import i Wynik. Submission oraz nazwy statusów workera pozostają w szczegółach technicznych.

## Strony i podstrony

| Obszar | Widok | Zawartość |
|---|---|---|
| Dostęp | Logowanie | Formularz; wymagane zmiany hasła jako dedykowany stan, nie drugi dashboard |
| Start | Dashboard | Skróty, wznowienie pracy, ostatnie wyniki i zadania |
| Narzędzia | Katalog | Rzeczywiste narzędzia oraz ich dostępność i dozwolone akcje |
| Narzędzie | Weryfikacja OC — przegląd | Nowy import, ostatnie importy, zadania i wyniki tego narzędzia |
| Dane | Importy narzędzia | Wcześniejsze pliki z filtrami i możliwością ponownego otwarcia |
| Dane | Szczegóły importu | Zakładki Dane / Przygotowanie / Uruchomienia; panel wzbogacania w Przygotowaniu |
| Uruchomienie | Podsumowanie przed startem | Wybór rekordów, data odniesienia, gotowe/pominięte/wymagające decyzji, liczba faktycznie tworzonych zadań |
| Zadania | Lista | Wszystkie dostępne zadania i partie; filtry statusu, narzędzia, autora i importu |
| Zadania | Szczegóły partii | Postęp i status każdego rekordu, powiązane zadania, przyczyny pominięć i anulowania |
| Zadania | Szczegóły zadania | Przebieg / Dane / Wynik, wymagane działania, link do importu i partii |
| Wyniki | Lista | Narzędzie, firma, identyfikator zadania, data, rezultat, plik i dostępne akcje |
| Wyniki | Szczegóły wyniku | Ten sam wynik i komponent co w zakładce zadania; trwały link, podsumowanie, dane i pobranie |
| Do obsługi | Kolejka czynności | Kategorie SMS / Dane / Decyzje, odpowiednio do praw; nie jeden uniwersalny formularz |
| Do obsługi | Szczegóły czynności | Kontekst zadania, konkretna akcja, historia i powrót do zadania |
| Konto | Moje konto | Podstawowe informacje, zmiana hasła i własne sesje |
| Audyt | Dziennik | Jeden widok; zakres i filtry wynikają z aktualnej roli |

Powyższa mapa jest propozycją organizacji, nie listą gotowych nowych tras. Obecne /imports, /runs, /results, /review, /audit, /account, /imports/[id], /runs/[id], /submissions/[id] i /tools/oc-policy-verification należy wykorzystać lub świadomie przekierować; nie usuwać dostępnych głębokich odnośników bez migracji.

## Administracja

Cztery grupy zamiast siedmiu równorzędnych wejść:

1. Użytkownicy i dostęp: lista kont; karta osoby z zakładkami Konto / Uprawnienia / Sesje. Granty narzędzi edytowane przy osobie. Przekrojowa macierz może być widokiem dodatkowym przy przyszłej rozbudowie.
2. Automatyzacje: lista istniejących narzędzi i karta ustawień konkretnego narzędzia; nowe starty, limity i okno pracy. Ustawienia nie włączają integracji portali.
3. Monitoring: dostępność usług, kolejki, zaległe zadania, dostawcy rejestru. Przydział otwartych interwencji w podwidoku tej grupy lub skrócie do Do obsługi z akcjami admina.
4. Audyt i raporty: wspólny dziennik oraz oddzielna zakładka raportów jakości. Nie tworzyć drugiego dziennika z innymi danymi.

Konta/sesje i dostępy zachowują osobne operacje API, choć są połączone w karcie osoby. Raporty jakości zachowują faktyczne definicje wskaźników, zwłaszcza odrębność braku polis i błędów.

## Przepływy

### Użytkownik wykonujący pracę

Dashboard → Narzędzie OC → nowy lub istniejący import → przygotowanie → wybór zakresu i podsumowanie → start → postęp partii/zadania → wynik → pobranie, jeśli dozwolone.

Problem danych: przygotowanie → propozycja korekty → oczekiwanie na decyzję → powrót do przygotowania. Nie każda oczekująca korekta blokuje pozostałe poprawne rekordy; podsumowanie startu musi ujawniać faktyczny zakres.

SMS: Dashboard/Do obsługi → ograniczony kontekst przypisanego zgłoszenia → wpisanie kodu → potwierdzenie przyjęcia → postęp tego samego zadania. Zamknięcie okna nie rozwiązuje interwencji.

### Menedżer

Dashboard → zadania lub Do obsługi → decyzja dotycząca korekty/konfliktu albo dozwolona interwencja → sprawdzenie postępu → wyniki organizacji w dostępnych narzędziach.

Nie dodawać zarządzania kontami, przydziału interwencji i raportów admina przez samo założenie, że nazwa roli to Menedżer. Nowe prawa wymagają osobnej decyzji.

### Administrator

Administracja → osoba → rola i granty → opcjonalne sesje; niezależnie Monitoring → zdiagnozuj problem / przydziel zgłoszenie; Automatyzacje → ustawienia nowych startów; Audyt i raporty → weryfikacja działań.

## Spójność interakcji i stanów

- Powrót zachowuje filtry, stronę listy i zaznaczenie; parametry list w URL.
- Każdy import, partia i zadanie ma trwały adres; użytkownik może wrócić po ponownym logowaniu.
- Wyniki dostępne z dashboardu, globalnej listy, narzędzia i zadania odsyłają do tego samego zasobu.
- Status procesu, rezultat i dostępność pliku są odrębne. Gotowy wynik / Brak polis / Błąd / Plik niedostępny nie mogą być jednym badge.
- Wygasła sesja, cofnięty grant, usunięty zasób, niedostępny dostawca i konflikt rewizji mają konkretne komunikaty i dalszą akcję.
- Zapis z nieaktualną wersją nie gubi edycji użytkownika; ponowienie wymaga odświeżenia danych.
- Liczniki i podpowiedzi wyszukiwania respektują ten sam zakres co listy.
- Sidebar domyślnie pokazuje podpisy. Może być zwijany i przypinany; stan zachowany. Hover może wspierać rozwijanie, ale klawiatura i dotyk muszą mieć równoważny przycisk.
- Mobile: drawer z tymi samymi pozycjami i trwałymi linkami; priorytet wyniku i czynności, nie całej szerokiej tabeli.
- Jedna rodzina sans w interfejsie; złoto wskazuje główne akcje i bieżące miejsce. Statusy mają osobną semantykę i podpisy.

## Konsekwencje i otwarte decyzje

1. Czy pracownik ma pozostać przy własnych wynikach, czy mieć dostęp do wyników innych pracowników w nadanym narzędziu? Obecny operator ma zakres własności. Sam grant do narzędzia nie udostępnia cudzych danych. Wspólne wyniki wymagają zmiany modelu zakresu, nie tylko frontendu.
2. Pobieranie bez prawa odczytu pozostaje legalną kombinacją grantu w obecnym modelu. Główna lista historii opiera się na odczycie; ewentualna lista Pliki do pobrania wymaga ograniczonego kontraktu API. Nie projektować pełnego podglądu danych dla samego grantu pobierania.
3. Uruchamianie bez odczytu musi otrzymać minimalne potwierdzenie i dopuszczony postęp; nie wolno przy okazji otwierać pełnych danych biznesowych. Istniejący ograniczony przepływ przypisanego SMS należy zachować.
4. Jeśli menedżer ma dodatkowo przydzielać interwencje lub korzystać z raportów jakości, należy określić nowe prawa i wprowadzić autoryzowane API. Aktualnie te funkcje są admin-only.
5. Globalna wyszukiwarka jest propozycją. Nie zakładać, że obecne endpointy dostarczają jej wyniki. Minimalna wersja może kierować do filtrowanych list.

## Co zmienia się wobec plansz 01–24

- Zachowujemy kierunek wizualny i główne komponenty; porządkujemy nawigację według zadań użytkownika.
- Historia operacji staje się Zadaniami, obejmującymi także zakończone pozycje. Importy pozostają w kontekście narzędzia i procesu.
- Wzbogacanie rejestru jest częścią przygotowania danych, nie drugim osobnym narzędziem w katalogu.
- SMS, wymagane dane i decyzje są dostępne przez Do obsługi, z różnymi prawami i formularzami.
- Przenosimy granty i sesje do karty użytkownika. Nie są siedmioma osobnymi głównymi sekcjami admina.
- Audyt ma jeden współdzielony ekran. Raporty jakości są osobnym widokiem admina.
- Nie kopiujemy przypadkowych metryk, oznaczeń ról, powielonych kolumn i aktywnych pozycji menu z wygenerowanych obrazów.

Następny projekt ekranów powinien wynikać z tej mapy i decyzji o własności wyników. Kod aplikacji w tej sesji nie został zmieniony.
