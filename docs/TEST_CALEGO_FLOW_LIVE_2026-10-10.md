# Rzeczywisty test całego flow — 10 października 2026

Na wyraźne polecenie sprawdzenia całego skryptu uruchomiono nowe zadanie 27e88295-f191-442b-9587-0450362772bf dla rzeczywistego wiersza 18001, z datą odniesienia 2026-10-10. Import, przygotowanie i start odbyły się przez API platformy. Przygotowanie wskazało ready=1 i brak błędów. Konsumpcja produkcyjnej kolejki została dopuszczona po potwierdzeniu jednego aktywnego zadania. Użyto istniejącego profilu pzu-login-rgswyS należącego do automatyzacji; nie otwierano portali w przeglądarce Codexa.

Potwierdzone rzeczywistymi zdarzeniami zadania:

- Logowanie PZU i wejście do Everest. Przejściowy stan oczekiwania SMS został automatycznie uzgodniony z authenticated, przez portal_authenticated_without_code. Nie podano kodu i nie ponawiano SMS.
- Odczyt i dopasowanie osoby dla wybranego wiersza w Everest oraz zapis tożsamości przez repozytorium produkcyjne. Dane osobowe nie są umieszczane w raporcie.
- Przejście do Compensy, logowanie i jedno rozpoczęcie komunikacji poprzez skrypt.
- Zatrzymanie na PORTAL_ACTION_REVIEW przy checkpointcie compensa_start_intent, bez external_case_ref. Nie wykonano zapisu osoby ani weryfikacji UFG i nie powstał produkcyjny XLSX.

Odczyt DOM po zatrzymaniu potwierdził pojedynczy widoczny numer sprawy, poprawny format po normalizacji i pojedyncze widoczne pole imienia. Konfiguracja tego testu miała już aktualny selektor numeru sprawy, a więc wcześniejsze wyjaśnienie starym .offer-number nie wystarcza do opisania tej próby.

W CompensaFormAssistant znaleziono lukę oczekiwania: widoczna sekcja osoby przerywała pętlę także wtedy, gdy recordDraftReference jeszcze nie potwierdził zapisu numeru. Poprawiono warunek zakończenia tak, by wymagał zarówno sekcji, jak i potwierdzonego checkpointu numeru sprawy. Zachowano ograniczony czas oczekiwania i brak ponownego rozpoczęcia oferty. Test z numerem dostępnym później niż formularz przeszedł wraz z trzema istniejącymi testami CEP: 4/4, bez pominięć. Build workera przeszedł. Nie przedstawiamy tej walidacji jako potwierdzenia naprawy na rzeczywistym portalu; późna dostępność numeru jest hipotezą zgodną z wykrytą luką, bez diagnostyki każdej poprzedniej próby callbacku.

Wynik tej wcześniejszej próby: NIEZALICZONY. Wcześniejsze testy syntetyczne zapisu/UFG/XLSX nie zastępują odbioru na portalu. Nie ustawiono fikcyjnego sukcesu zadania, nie wpisano ręcznie numeru sprawy do bazy i nie wykonywano ręcznych kliknięć zapisujących dane poza kolejką.

## Ponowny odbiór po poprawkach — wynik ZALICZONY dla wiersza 18001

Rzeczywiste zadanie `919c2263-09a3-4ecb-90ce-76cc349ddda0`, import `a12c11ae-a8be-470d-8eec-0086cfb818e1`, zakończyło się statusem `completed`, bez błędu i otwartego zgłoszenia. Uruchomiono je przez API platformy i produkcyjną kolejkę, w persistent Chromium workera z zapamiętanym urządzeniem. PZU/Everest, dopasowanie osoby, logowanie Compensa, pobranie danych pojazdu, formularz osoby, zapis, UFG, szczegóły OC i przekazanie wyniku do API wykonał skrypt. Nie podano nowego SMS; przejściowe zgłoszenie zostało uzgodnione przez `portal_authenticated_without_code`.

Potwierdzenie wyniku:

- Snapshot UFG: 49 polis OC, w bazie zapisane wszystkie 49.
- Data odniesienia platformy: 2026-10-10. Reguła pozostaje: koniec ochrony >= data odniesienia.
- Plik pobrany rzeczywistym endpointem artefaktu: 3 polisy, 15 kolumn. Wszystkie komórki danych porównano z zapisanym wejściem i politykami w PostgreSQL, bez wypisywania wartości osobowych.
- Zdarzenia udanego zadania: dokładnie jedno rozpoczęcie sprawy, jeden potwierdzony zapis osoby i jeden zamiar weryfikacji UFG.
- Po teście kolejkę wstrzymano; nie uruchomiono pozostałych wierszy importu.

Naprawy wynikające z obserwacji rzeczywistych prób:

1. Numer sprawy i formularz muszą być dostępne łącznie przed kontynuowaniem. Nowy wiersz rozpoczyna przejście od strony wejściowej Compensy, bez przejmowania poprzedniej sprawy.
2. Przyciski Save/UFG/details są rozpoznawane po ikonie i tekście, z prefiksem dynamicznego ID dla UFG, bez zapisania konkretnego losowego ID. Oczekiwanie jest ograniczone czasem; cel musi być pojedynczy, widoczny i aktywny.
3. Podsumowanie na stronie (`table.table-borderless` z „Liczba polis” i „Liczba zdarzeń”) różni się od podsumowania w oknie szczegółów. Ogólny selektor wskazywał dwie tabele po otwarciu okna; selektor tabeli okna nie istniał przed jego otwarciem. Konfiguracja wskazuje teraz tabelę strony w obu stanach.
4. Windows pakietowy przekierowywał LocalAppData do LocalCache. Bootstrap testowego workera używa rzeczywistej ścieżki katalogu staging; kontrole symlinków i szyfrowania pozostają aktywne.
5. Repozytorium odczytuje SQL DATE jako tekst, aby lokalna północ nie przesunęła daty o dzień podczas konwersji do UTC. Eksport platformy w udanym zadaniu miał prawidłową datę 2026-10-10.
6. Brak zapisu, niepewny zapis i błędy UFG/szczegółów kończą dany wiersz jako `failed`, bez eksportu i bez blokowania kolejki zgłoszeniem ręcznym. Kontrola tożsamości, SMS i nieoczekiwane błędy infrastruktury zachowują osobne ścieżki interwencji.

Wcześniejsze zadania `db7b6db6-6782-4bb3-b76c-a2d74ae55a9d` i `9830eb8d-b2d2-4bde-b147-428bf6a329d0` zatrzymały się na selektorze podsumowania; readonly diagnostyka odczytała potem 49/49 bez ponawiania UFG. Zadanie `4b33bfa0-5aac-4a05-aa37-d1931fc46432` dotarło do odczytu, lecz zatrzymało się przy katalogu staging. Ich statusów nie zamieniano ręcznie na sukces. Każda z tych prób utworzyła oddzielną sprawę testową; licznik jednej sprawy dotyczy udanego przebiegu, nie całej sesji diagnostycznej.

Walidacja lokalna: 17/17 testów LiveRun i happy flow (w tym opóźnione przyciski, dynamiczne ID, myląca dodatkowa tabela i niepowtarzanie zapisu/UFG); 24/24 testy form/save/UFG przed ostatnią korektą tabeli; ponownie 16/16 form/UFG oraz 2/2 happy flow po korektach; 4/4 repozytorium, build workera. Skrypt `scripts/verify-live-acceptance-artifact.cjs` zweryfikował rzeczywisty XLSX. Odbiór jednego wiersza potwierdza poprawny przebieg; nie dowodzi odporności na każdy możliwy przypadek ani gotowości całego importu bez nadzoru.
