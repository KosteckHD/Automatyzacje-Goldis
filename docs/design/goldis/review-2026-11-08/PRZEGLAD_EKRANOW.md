# Goldis — screenshoty i ocena ekran po ekranie

8 listopada 2026 · 35 widoków · komputer i telefon

Dane testowe, aktualny lokalny interfejs. P1 — ważne przed przekazaniem klientowi; P2 — poprawa wygody; P3 — dopracowanie.

## 1. Logowanie — komputer — Komputer

**Bez istotnych uwag** · Marka i formularz mają wyraźnie oddzielone obszary. Etykiety pól są widoczne, a pojedynczy złoty przycisk jasno wskazuje następny krok.

**Zalecenie:** Zachować prosty formularz i widoczną ścieżkę odzyskania hasła. W tej próbce brak istotnego problemu wizualnego.

![Logowanie — komputer](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c01-login.png>)

## 2. Przegląd — komputer — Komputer

**Bez istotnych uwag** · Widok wyraźnie oddziela pilną czynność, liczby oraz ostatnie operacje. Główna akcja i sekcja „Do zrobienia” są łatwe do znalezienia. W tej próbce nie ma istotnej wady układu.

**Zalecenie:** Zachować hierarchię: jedna główna akcja, pilne sprawy przed historią. Nie zmieniać układu na podstawie niespójnych wartości demonstracyjnych.

![Przegląd — komputer](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a01-dashboard-desktop.png>)

## 3. Katalog automatyzacji — Komputer

**Bez istotnych uwag** · Dwie automatyzacje mają odrębne, krótkie opisy i duże przyciski otwarcia. Stan dostępności oraz zakres możliwości da się odczytać przed wejściem do narzędzia.

**Zalecenie:** Zachować porównywalny układ kart i opisy mówiące, co użytkownik zrobi w module.

![Katalog automatyzacji](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c02-tools.png>)

## 4. Sprawdzanie OC — dodanie pliku — Komputer

**Bez istotnych uwag** · Miejsce dodania pliku jest duże i jednoznaczne, a wymagania dotyczące formatu, arkusza i kolumn są dostępne przed importem.

**Zalecenie:** Zachować widoczne wymagania i zapewnienie, że import nie uruchamia portali. Brak istotnej poprawki wizualnej w tej próbce.

![Sprawdzanie OC — dodanie pliku](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a02-oc-upload-desktop.png>)

## 5. Szczegóły importu — kontrola danych — Komputer

**P2** · Filtry i paginacja mają nierówny rytm: niskie pole wyszukiwania ginie między kontrolkami, a „Następna” spada do osobnej linii.

**Do poprawy:** Ujednolicić wysokość pól i umieścić paginację w jednym wierszu pod tabelą; zostawić nad tabelą tylko filtry.

![Szczegóły importu — kontrola danych](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c06-import-detail.png>)

## 6. Sprawdzanie OC — wybór firm — Komputer

**P1** · Indywidualne pola wyboru firm są małe, a źródło i niezależny AX tego samego ekranu potwierdzają, że nie mają nazw dostępnych. Czytnik nie otrzymuje powiązania checkboxa z firmą.

**Do poprawy:** Objąć wiersz elementem label lub połączyć input z nazwą firmy i numerem wiersza przez aria-labelledby. Powiększyć klikalny obszar wiersza.

![Sprawdzanie OC — wybór firm](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a04-oc-selection-desktop.png>)

## 7. Szczegóły przebiegu — Komputer

**P2** · Wynik i historia zadania są dostępne, ale jasna etykieta przycisku pobrania słabo odcina się od złotego tła.

**Do poprawy:** Użyć ciemnej etykiety na złotym przycisku, tak jak w pozostałych głównych akcjach platformy.

![Szczegóły przebiegu](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c08-run-detail.png>)

## 8. Historia importów — Komputer

**P3** · Nazwa pliku i przycisk otwarcia są czytelne. Nad nazwą pliku użytkownik otrzymuje jednak techniczny kod „oc-policy-verification”, który wymaga tłumaczenia na nazwę narzędzia.

**Do poprawy:** Wyświetlać „Sprawdzanie OC” jako nazwę narzędzia, a kod techniczny schować w szczegółach.

![Historia importów](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c05-imports.png>)

## 9. Historia przebiegów — Komputer

**P2** · Wpis jest identyfikowany głównie numerem wiersza i długim UUID importu. Przy wielu przebiegach klient musi pamiętać, do jakiego pliku lub firmy odnosi się zadanie.

**Do poprawy:** W tytule wpisu pokazać nazwę firmy lub pliku oraz numer wiersza; identyfikator techniczny przenieść do szczegółów.

![Historia przebiegów](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c07-runs.png>)

## 10. Historia wyników OC — Komputer

**P2** · Wynik można otworzyć lub pobrać, ale pozycja jest nazwana jedynie „Wiersz 14”. Nie widać nazwy firmy ani pliku, co utrudnia odnalezienie właściwego wyniku.

**Do poprawy:** Nazwać wynik firmą i plikiem źródłowym, zostawiając numer wiersza jako informację pomocniczą.

![Historia wyników OC](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c09-result-history.png>)

## 11. Stan zgłoszenia — Komputer

**P2** · Dziewięć równorzędnych kafli miesza wielkość zgłoszenia, grupy i stany pracy. Użytkownik musi sam ustalić, które liczby mówią o następnym wymaganym działaniu.

**Do poprawy:** Wyróżnić trzy podsumowania: zakończone, w toku, wymagające działania. Liczbę wierszy i grup umieścić w osobnej, spokojniejszej sekcji szczegółów.

![Stan zgłoszenia](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c10-submission.png>)

## 12. Moje firmy — aktualna lista — Komputer

**P2** · Telefon i e-mail są klikalne, lecz tekst etykiet zlewa się z wartościami w komórce kontaktu. Spowalnia to wybór właściwego kanału kontaktu.

**Do poprawy:** Rozdzielić telefon i e-mail na dwa wiersze z odstępem między etykietą a wartością.

![Moje firmy — aktualna lista](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c03-my-results.png>)

## 13. Pula firm — komputer — Komputer

**P2** · W tabeli puli dane telefonu i e-maila zlewają się z etykietami. Duża liczba kolumn jeszcze wzmacnia koszt wzrokowego rozdzielania tych danych.

**Do poprawy:** Ułożyć kanały kontaktu w oddzielnych wierszach z czytelną etykietą i klikalną wartością.

![Pula firm — komputer](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c04-pool.png>)

## 14. Szczegóły firmy — Komputer

**P2** · Dane kontaktowe są blisko decyzji po rozmowie, lecz nazwy pól sklejają się z wartościami. Pod nazwą firmy podobnie zlewają się nawigacja kolejki i jej opis.

**Do poprawy:** Rozdzielić etykiety i wartości kontaktu wierszami z odstępami. Nawigację poprzednia/następna oraz stan kolejki ułożyć jako trzy odrębne elementy.

![Szczegóły firmy](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c23-lead-detail.png>)

## 15. Porównywarka prowizji — komputer — Komputer

**P2** · Po wczytaniu plików start pozostaje nieaktywny, a ekran pokazuje tylko „0 wybranych plików”. Nie podpowiada przy przycisku, że trzeba zaznaczyć CRM i co najmniej jeden raport.

**Do poprawy:** Obok nieaktywnego startu wyświetlić konkretny warunek: „Zaznacz plik CRM oraz raport ASF lub Warty”.

![Porównywarka prowizji — komputer](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a07-commission-desktop.png>)

## 16. Słownik prowizji — komputer — Komputer

**Bez istotnych uwag** · Aktywna wersja, filtry i oddzielne kolumny stawek są czytelne. Stan opublikowania jest widoczny w kontrolce wersji i podsumowaniu.

**Zalecenie:** Zachować widoczną wersję słownika przy tabeli. Dla tej próbki nie ma istotnej wady wizualnej.

![Słownik prowizji — komputer](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a08-commission-dictionary-desktop.png>)

## 17. Historia analiz prowizji — Komputer

**Bez istotnych uwag** · Okres, data utworzenia, opisowy status i liczby rozbieżności są widoczne w jednym wierszu. Osobny przycisk „Otwórz wynik” jasno wyznacza dalszą akcję.

**Zalecenie:** Zachować opisowe statusy i bezpośredni dostęp do wyniku. W tej próbce nie ma istotnego problemu wizualnego.

![Historia analiz prowizji](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c24-commission-history.png>)

## 18. Wynik analizy prowizji — Komputer

**P2** · Po otwarciu wyniku z historii użytkownik nadal widzi na górze formularz nowej analizy, a właściwy wynik leży pod wszystkimi kontrolkami wczytywania i startu. Kontekst oglądania wyniku jest mało wyraźny.

**Do poprawy:** Otwierać historyczny wynik w osobnym widoku albo przynajmniej przenosić focus i przewijanie do nagłówka „Wynik analizy”, zwijając formularz nowego uruchomienia.

![Wynik analizy prowizji](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c25-commission-result.png>)

## 19. Powiadomienia — Komputer

**P1** · Ekran pozostaje przy „Sprawdzam sesję…” i nie daje dostępu do powiadomień. Niezależne sprawdzenie źródła potwierdza brak przełączenia authenticated na true po sukcesie sesji.

**Do poprawy:** Domknąć stan powodzenia sprawdzania sesji i wyświetlić listę; przy błędzie dać odzyskiwalny komunikat oraz ponowienie.

![Powiadomienia](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c11-notifications.png>)

## 20. Konto i bezpieczeństwo — Komputer

**Bez istotnych uwag** · Odzyskiwanie, zmiana hasła i sesje są rozdzielone w osobnych panelach. Wymagana długość hasła i skutek wylogowania innych sesji są podane przed zapisem.

**Zalecenie:** Zachować wyjaśnienie skutków zmiany przy formularzu. Daty i liczby aktywnych sesji są demonstracyjne, więc nie oceniam ich jako błędu produktu.

![Konto i bezpieczeństwo](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c12-account.png>)

## 21. Pracownicy — Komputer

**P2** · Na komputerze najważniejsza akcja „Zarządzaj” leży w uciętej prawej kolumnie tabeli. Menedżer musi przesuwać tabelę, aby znaleźć zarządzanie kontem.

**Do poprawy:** Przypiąć kolumnę akcji do prawej krawędzi lub przenieść „Zarządzaj” przy nazwę pracownika; ograniczyć szerokość kolumn pomocniczych.

![Pracownicy](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c13-team.png>)

## 22. Dostępy do narzędzi — Komputer

**Bez istotnych uwag** · Widok rozróżnia wspólny odczyt wyników od prawa uruchamiania i uprzedza, że zmiany zapisują się od razu. Opis stanu obok przełącznika ułatwia interpretację.

**Zalecenie:** Zachować rozdzielenie zakresów dostępu i tekstowe określenie stanu przy przełączniku. Nie traktować demonstracyjnych wartości uprawnień jako problemu UI.

![Dostępy do narzędzi](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c14-access.png>)

## 23. Raporty — Komputer

**Bez istotnych uwag** · Raport oddziela obsługę klientów od automatyzacji. Wyjaśnienie przy zakresie dat mówi, że statusy opisują stan bieżący, co zapobiega myleniu raportu z historią telefonów.

**Zalecenie:** Zachować wyjaśnienie podstawy raportu przy filtrze oraz podpisy pod liczbami. W tej próbce nie ma istotnej przeszkody wizualnej.

![Raporty](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c15-reports.png>)

## 24. Korekty REGON — Komputer

**P2** · Filtrowanie importu wymaga skopiowania technicznego identyfikatora z adresu innej strony, a narzędzie wpisuje się jako kod. To zmusza recenzenta do przełączania ekranów i zapamiętywania identyfikatorów.

**Do poprawy:** Zastąpić pole identyfikatora wyszukiwarką importów po nazwie pliku i dacie, a kod narzędzia listą znanych nazw.

![Korekty REGON](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c16-review.png>)

## 25. Dziennik audytu — Komputer

**P2** · Główne nazwy zdarzeń są kodami typu „lead.allocated”, a zasób opisuje UUID. Audytor musi znać techniczne słownictwo, aby szybko odczytać co się wydarzyło.

**Do poprawy:** Wyświetlić polski opis zdarzenia i rozpoznawalną nazwę zasobu, pozostawiając kody i UUID w rozwijanych szczegółach.

![Dziennik audytu](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c17-audit.png>)

## 26. Administracja — komputer — Komputer

**P2** · Panel zbiera uprawnienia, konta, sesje, operacje, kolejkę interwencji, ustawienia, audyt i raporty w jednym bardzo długim widoku. Akcje o różnych skutkach konkurują o uwagę administratora.

**Do poprawy:** Użyć istniejącej nawigacji sekcji do wyświetlania tylko wybranego obszaru, zamiast pokazywać wszystkie formularze naraz.

![Administracja — komputer](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c18-admin.png>)

## 27. Logowanie — telefon — Telefon

**Bez istotnych uwag** · Formularz mieści się w szerokości telefonu, pola i przycisk są duże, a link odzyskania hasła pozostaje bezpośrednio pod akcją logowania.

**Zalecenie:** Zachować duże kontrolki i krótką drogę do odzyskania dostępu. Brak istotnego problemu układu w tej próbce.

![Logowanie — telefon](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c19-login-mobile.png>)

## 28. Przegląd — telefon — Telefon

**Bez istotnych uwag** · Najważniejsze działanie pozostaje nad statystykami, a pilne sprawy i operacje przechodzą w czytelną pojedynczą kolumnę. Menu ma duży przycisk.

**Zalecenie:** Zachować kolejność główna akcja → pilne sprawy → historia. Brak istotnego problemu układu w badanym widoku.

![Przegląd — telefon](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a09-dashboard-mobile.png>)

## 29. Wybór firm OC — telefon — Telefon

**P2** · Przed pierwszą firmą trzeba przewinąć ponad ekran nagłówków i objaśnień: selektor kroku, nagłówek kroku, drugi tytuł wyboru i osobny nagłówek listy powtarzają podobny komunikat.

**Do poprawy:** Na telefonie zostawić jeden nagłówek kroku, skrócić wstęp i przenieść wybór zakresu oraz wyszukiwanie bezpośrednio nad listę firm.

![Wybór firm OC — telefon](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a10-oc-mobile.png>)

## 30. Moje firmy — telefon, aktualna próbka — Telefon

**P2** · Karta firmy jest czytelna, ale eksport został wciśnięty obok wielowierszowego tytułu i sam łamie etykietę na trzy linie.

**Do poprawy:** Przenieść eksport i odświeżenie do pełnego wiersza pod nagłówkiem listy, z jednowierszowymi etykietami i dużym obszarem dotyku.

![Moje firmy — telefon, aktualna próbka](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c20-my-results-mobile.png>)

## 31. Pula firm — telefon — Telefon

**P2** · Formularz przydziału dobrze przechodzi do jednej kolumny, lecz tytuł tabeli i akcje eksportu ponownie konkurują w ciasnym nagłówku. Etykieta eksportu rozpada się na kilka krótkich linii.

**Do poprawy:** Przenieść akcje listy do osobnego wiersza na pełną szerokość pod tytułem; zachować jednokolumnowy formularz przydziału.

![Pula firm — telefon](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c21-pool-mobile.png>)

## 32. Porównywarka prowizji — telefon — Telefon

**P2** · Tabela wymaga przesuwania w poziomie, żeby odczytać nazwy plików, a zaznaczanie odbywa się przez bardzo małe checkboxy. Trudno pewnie wybrać właściwy plik jedną ręką.

**Do poprawy:** Zastąpić mobilną tabelę kartami lub wierszami z pełną nazwą i klikalnym obszarem zaznaczenia o wysokości co najmniej 44 px.

![Porównywarka prowizji — telefon](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a11-commission-mobile.png>)

## 33. Porównywarka — brak plików na telefonie — Telefon

**P2** · Instrukcja pustej listy jest umieszczona w szerokiej tabeli i na telefonie zostaje ucięta. Użytkownik widzi początek „Dodaj plik CRM oraz…” bez pełnej wskazówki.

**Do poprawy:** Wyświetlić pusty stan poza przewijaną tabelą, na pełną szerokość panelu, z kompletnym opisem wymaganego zestawu plików.

![Porównywarka — brak plików na telefonie](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a12-commission-empty-mobile.png>)

## 34. Porównywarka — błąd wczytywania — Telefon

**P2** · Alert prosi „Spróbuj ponownie”, ale nie ma obok takiej akcji. Jednocześnie panel pokazuje brak plików i słownika jak stan potwierdzony, choć pobranie danych nie powiodło się.

**Do poprawy:** Dodać przy alercie przycisk ponownego wczytania i odróżnić dane nieodczytane od rzeczywiście pustych list. Ocena dotyczy prezentacji błędu, nie wymuszonej awarii syntetycznego API.

![Porównywarka — błąd wczytywania](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/a13-commission-error-mobile.png>)

## 35. Administracja — telefon — Telefon

**P2** · Na telefonie wszystkie sekcje administracji tworzą stronę o wysokości około 7600 px. Lokalna czynność, np. sprawdzenie sesji, wymaga orientowania się w bardzo szerokim zakresie funkcji i formularzy.

**Do poprawy:** Pokazywać jedną wybraną sekcję administracji naraz, z czytelnym przełącznikiem sekcji nad jej zawartością.

![Administracja — telefon](<C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/design/goldis/review-2026-11-08/c22-admin-mobile.png>)
