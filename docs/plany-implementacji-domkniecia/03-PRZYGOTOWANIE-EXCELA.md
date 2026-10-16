# 3. Plan implementacji przygotowania całego Excela

Data: 8 października 2026. Obowiązują [wspólne zasady](README.md). Zależności: punkty 1–2; obejmuje P02/P03 i reguły przygotowania planu nadrzędnego.

## Cel i założenia

Przed portalami system przygotowuje cały import: waliduje i normalizuje dane, wykrywa duplikaty, uzupełnia REGON przez NIP, ponownie deduplikuje i przedstawia rozliczenie. Żaden niepusty wiersz nie znika bez statusu. Przygotowanie nie tworzy oferty i nie uruchamia UFG.

Oryginalne wartości/numery wierszy pozostają źródłem. Zestaw przygotowany jest osobną wersją danych. Brak REGON i NIP oznacza pominięcie; błędna wpisana wartość oznacza korektę lub świadome pominięcie. Brak nazwy nie powinien uniemożliwiać odnotowania rekordu i zgłoszenia problemu.

Istnieją parser, normalizacja, grupowanie kanoniczne, review, MF/GUS, enrichment jobs, cache i budżet dzienny. W trakcie realizacji rozszerzono parser o arkusze `Nazwa`+NIP bez kolumny REGON oraz pierwszy przebieg oznaczania duplikatów; szczegóły i pozostały zakres są w [raporcie wdrożenia](../STATUS_WDROZENIA_PLANOW_1-7_2026-10-08.md). Enrichment job nadal wybiera do 500 wierszy. Budżet i pojedynczy enrichment worker nie gwarantują tempa rzeczywistych requestów.

## Mapa kodu

| Obszar | Punkt startowy |
| --- | --- |
| Import/parser | [imports.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/imports.ts), [workbook.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/workbook.ts), [workbook-archive.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/workbook-archive.ts) |
| Grupowanie i review | [entity-grouping-service.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/entity-grouping-service.ts), [review-service.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/review-service.ts) |
| Rejestr i transport | [registry-result.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/registry-result.ts), [registry-lookup.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/registry-lookup.ts), [gus-bir-provider.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/gus-bir-provider.ts), [mf-vat-provider.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/mf-vat-provider.ts) |
| Trwałe zadania | [enrichment-jobs.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/enrichment-jobs.ts), [enrichment-worker.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/enrichment-worker.ts) |
| Panel | [enrichment-review.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/enrichment-review.tsx), [workspace.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/workspace.tsx) |

## Proponowany model i API

Nazwy poniżej są projektowane:

- `ImportPreparation`: tenant/batch, actor, revision, rulesVersion, sourceFingerprint, stage, status, cursor, counters, lease i timestamps. Statusy: queued/processing/waiting_provider/completed/completed_with_attention/cancelled/failed; etap osobny.
- `PreparedSourceRow`: preparation/sourceRow/rowNumber, expectedSourceVersion, wartości efektywne, provenance, typ wstępny z dowodem, reason/status oraz representative ID. Statusy rozłączne: ready/review/skipped_no_identifiers/duplicate/excluded/waiting_registry.
- Przed seal revision dane robocze aktualizowane przez CAS. Po seal niezmienne; korekta, wznowiony rejestr lub zmiana reguł tworzy kolejną revision z mapą zmian. Run korzysta z zapisanych wartości przygotowania, nie z później edytowanego źródła.
- `POST /api/imports/:id/preparations`: wersja importu/reguł + klucz idempotencji; 202 i preparationId. `GET /api/preparations/:id`, `/rows`, `/summary`; operacje cancel/rebuild z wersją. Kontrolowany eksport cleaned dataset/raportu. Potwierdzić konwencję tras przed implementacją.
- Rejestr: provider/scope/wersja/dzień danych/fetchedAt i zweryfikowane NIP/REGON. Cache nie jest dowodem aktualności polis. Nie dopisywać danych reprezentantów z rejestru, jeśli nie są potrzebne flow.

## Implementacja krok po kroku

1. **Ustalić fixture i kontrakt.** Przygotować pliki: obecny format, tylko NIP, puste identyfikatory, złe nagłówki, formuły, zera wiodące, duplikaty i jednostki lokalne. Zapisz oczekiwany wynik każdego wiersza; rozdziel blocking issues i ostrzeżenia.
2. **Rozszerzyć parser.** `Nazwa` i przynajmniej jedna kolumna NIP/REGON; trim/case nagłówków, odrzucenie duplikowanych kolumn kluczowych, zachowanie numerów wierszy. Całkowicie puste wiersze policzyć oddzielnie. Nie wykonywać formuł; utrata cyfr w numerycznej komórce daje jawny problem. Zachować limity archive/upload i pojemności parsera.
3. **Zaimplementować normalizację.** Czyste funkcje dla identyfikatorów/nazwy/adresu; walidacja checksum i długości. Przechować raw i normalized; format nazwy prawnej nie jest zgadywanym dopasowaniem. Przygotować severity/reason codes, aby nieblokujące ostrzeżenie nie odrzucało poprawnego podmiotu.
4. **Dodać schemat przygotowania.** Migracja tabel/FK/unikalności revision/idempotencji i indeksów batch/status/cursor. Blokada przygotowania równoległego tej samej wersji. Wersję źródła sprawdzać w transakcji przed utworzeniem pracy, z tenant i prawami.
5. **Dodać usługę i kontroler.** Rejestracja w API module, walidacja body, CSRF, aktualna autoryzacja i minimalny audyt. Oddzielić zlecenie od wykonania. Status odczytywany z DB, a nie obliczany tylko z pamięci workera.
6. **Pierwsza deduplikacja.** Kandydaci według poprawnego NIP/REGON; usunięcie tylko przy zgodnej tożsamości/danych. Preferować najpełniejszy niesprzeczny wiersz, przy remisie wcześniejszy. Reprezentant i provenance utrwalone; konflikt osób/REGON jednostek lokalnych trafia do review. Globalny przebieg po całym przygotowaniu.
7. **Wybrać lookup.** Tylko wiersze bez poprawnego REGON i z poprawnym NIP. Jeden lookup dla powtarzającego się NIP, z mapą odbiorców; wykorzystać istniejące jobs do 500 pozycji, trwały kursor i kontrolowany outbox. Nie czyścić oryginalnych source issues tylko po to, by wymusić gotowość.
8. **Dodać limiter rzeczywistego transportu.** Atomowa rezerwacja przed każdym SOAP/HTTP, także login/relogin/retry, wspólna dla scope dostawcy. Proponowane trwałe tabele scope/reservations/cooldown z DB clock i krótką transakcją; wszystkie procesy używają jednej implementacji. Nie wykonywać HTTP w blokadzie DB. Nie „oddawać” budżetu po niepewnym wysłaniu.
9. **Budżet i odroczenia.** GUS: na początek minimum 1 s między startami SOAP, brak burstu i egzekwowane oficjalne okna. MF: batch do limitu dostawcy, budżet dobowy i konfigurowalny odstęp. Retry-After sekundy/data, wspólny cooldown, ograniczone retry; długa przerwa zapisuje nextAttemptAt i zwalnia slot. Awaria limitera blokuje transport. Kwoty sprawdzić w aktualnej oficjalnej specyfikacji przed kodowaniem.
10. **Mapować wyniki bez zgadywania.** Jeden zgodny NIP i dopuszczalny REGON; nazwa/typ jednostki muszą spełnić istniejące reguły dopasowania. Mismatch/ambiguous/not_found do review, błąd systemowy do waiting_registry. GUS preferowany po kluczu, MF jawne źródło pomocnicze; fallback nie jest sposobem obejścia wspólnego ograniczenia konta/IP.
11. **Druga deduplikacja i klasyfikacja.** Ponownie sprawdzić całość po lookup, w tym duplikaty z różnych paczek. Rozstrzygnąć konflikty używając istniejącego review. Typ z rejestru to dowód wstępny; gotowość konkretnej ścieżki zależy też od capabilities punktu 5. Nie używać nazwy jako jedynego dowodu typu.
12. **Finalizacja revision.** Uzgodnić liczniki, sprawdzić aktualne wersje źródeł i rights/deletion, obliczyć fingerprint kanonicznej reprezentacji. Seal tylko spójnego obrazu. Nie gotowe rekordy pozostają rozliczone; późniejsze uzupełnienie tworzy nową revision, nie mutuje wejścia aktywnego runu.
13. **UI przygotowania.** Przycisk, etap, postęp i kategorie; raport duplikatów/źródeł REGON; filtrowanie problemów, korekta i przebudowa. Start gotowych danych wymaga jawnego summary; oczekujące pozycje nie są udawane jako ukończone. Wprowadzić zgodne tokeny kontrastu panelu enrichment.
14. **Eksport i odbiór.** Cleaned dataset bez duplikatów, osobny raport wszystkich wierszy i przyczyn. Zabezpieczyć komórki przed formułą. Testy parser/grouping/registry/jobs/UI oraz nowy izolowany moduł preparation, kończący się na sealed revision, bez portali.

## Punkty odbioru

| ID | Kryterium |
| --- | --- |
| D01 | Każdy niepusty wiersz importu ma dokładnie jedną kategorię i oryginalny numer. |
| D02 | Brak obu identyfikatorów daje pominięcie bez requestu; błędny identyfikator nie jest używany. |
| D03 | NIP→REGON dopiero po jednoznacznej walidacji; provenance i data widoczne. |
| D04 | Obie deduplikacje zachowują jednego właściwego reprezentanta; konflikt nie jest cichym merge. |
| D05 | Suma kategorii równa liczbie wierszy danych; źródłowy import zachowany. |
| D06 | Limity dotyczą rzeczywistych wywołań, dwóch procesów i restartu; cache nie zużywa HTTP. |
| D07 | Restart/utrata lease/korekta w trakcie przygotowania nie tworzy niespójnej revision. |
| D08 | Wgrywanie i preparation mieszczą się w limitach pamięci/rozmiaru, bez częściowego ukrytego sukcesu. |
| D09 | Cleaned export i raport odpowiadają tej samej revision; UI obsługuje brak dostawcy i review. |

## Testy szczególne i przekazanie

Fixture: valid REGON bez NIP; valid NIP bez REGON; oba puste; błędny checksum; NIP z zerem; dwie jednostki jednego podmiotu; podobne nazwy różnych firm; konflikt osoby; drugi duplikat po enrichment. Provider fixture: 429/date Retry-After, login/search/session expiry/relogin, timeout po wysłaniu, invalid payload, not_found i dwa procesy z fake clock/DB clock. Sprawdzić zmianę dnia Europe/Warsaw oraz restart bez resetu budżetu.

Źródła kwot: [GUS BIR](https://api.stat.gov.pl/Home/RegonApi), [MF API](https://www.gov.pl/web/kas/api-wykazu-podatnikow-vat); wcześniejsza weryfikacja 8 października 2026. Budżet 6000/dobę w aplikacji nie jest oficjalnym limitem godzinowym GUS.

Przekazać schemat preparation, version/fingerprint contract, słownik reason codes, przykładowy plik i raport. Kontrakt sealed revision stanowi wejście punktu 4. Przygotowanie wszystkich danych jest odbierane osobno od skutków portalowych.
