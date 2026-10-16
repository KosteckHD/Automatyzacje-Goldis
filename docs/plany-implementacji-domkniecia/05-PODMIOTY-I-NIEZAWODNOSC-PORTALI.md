# 5. Plan implementacji typów podmiotów i niezawodności portali

Data: 8 października 2026. Obowiązują [wspólne zasady](README.md). Zależności: punkty 1–4, wspólne sterowanie z punktem 6 oraz kontrakt wyniku z punktem 7. Obejmuje P05/P06 planu nadrzędnego.

## Cel i założenia

Obsługiwać wszystkie wymagane typy podmiotów z zaakceptowanego Excela przez właściwą ścieżkę identyfikacji i formularza. Przy restarcie, utracie sesji, timeout lub niepewnym zapisie odzyskać stan albo zgłosić konkretną interwencję. Nie przypisywać polisy/sprawy innemu podmiotowi i nie powtarzać automatycznie niepewnej operacji.

Obecny `IdentityResolution` wymaga personName/PESEL i resolver dopuszcza potwierdzoną JDG. `RunIdentity`, worker payload i `run-export.ts` są powiązane z PESEL. Samo dodanie nowej opcji do formularza Compensy nie obsłuży spółki od wejścia do eksportu.

Nie znamy jeszcze potwierdzonych ścieżek wszystkich form działalności na rzeczywistych portalach. Najpierw rozpoznać capabilities i potrzebne dane. Kod/testy budować na lokalnych fixture; brak możliwości portalu raportować jako blokadę konkretnej ścieżki, bez deklaracji pełnego ukończenia. Rzeczywista inspekcja/logowanie wymaga odrębnie zleconego zakresu użytkownika.

## Mapa kodu

| Obszar | Punkt startowy |
| --- | --- |
| Tożsamość | [identity.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/identity.ts), [everest-identity-provider.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/everest-identity-provider.ts) |
| Formularz i zapis | [compensa-form.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/compensa-form.ts), [compensa-offer-saver.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/compensa-offer-saver.ts), [compensa-offer-checkpoint.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/compensa-offer-checkpoint.ts) |
| Skutki i lease | [portal-action-gate.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/portal-action-gate.ts), [execution-lease.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/execution-lease.ts) |
| Runtime i UFG | [live-run.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/live-run.ts), [run-worker.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/run-worker.ts), [compensa-ufg.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/compensa-ufg.ts) |
| Kontrakty API/eksport | [index.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/packages/core/src/index.ts), [worker-results.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/worker-results.ts), [run-export.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/run-export.ts) |

## Docelowe kontrakty

**Identity V2**, propozycja discriminated union:

- `sole_proprietor`: potwierdzony REGON/NIP firmy oraz powiązana osoba/PESEL, source row i dowód dopasowania.
- `legal_entity`: potwierdzona tożsamość firmy; PESEL nie jest obowiązkowym polem. Dane reprezentanta osobne i tylko wtedy, gdy wymagane oraz potwierdzone.
- `local_unit/other_business`: zachowana relacja jednostki i podmiotu nadrzędnego; właściwa strategia formularza ustalana po capabilities. `unknown` jest stanem review, nie gotową tożsamością.
- Dowód: source/preparation revision, portal candidate reference, źródło faktycznie odczytanego identyfikatora, adapterVersion, validatedAt i confidence reason. Nie przypisywać candidate REGON wyłącznie z parametru wyszukiwania, jeśli portal go nie potwierdził.

**Capabilities matrix:** typ→portal/formularz→identyfikator→obowiązkowe dane→zewnętrzne akcje→sposób odzyskania sprawy→status odebrania. Nie wykrywać typu tylko z końcówki nazwy firmy.

**Portal action checkpoint:** actionKey/run/profile, intent, caseReference/operationReference, adapterVersion, evidence, state `planned/sent_uncertain/confirmed/reconciled/manual_required`. Adaptować istniejące gate/checkpoint, bez równoległego konkurencyjnego rejestru. Samo utrwalenie intent nie oznacza, że wiadomo, czy portal wykonał akcję.

## Implementacja krok po kroku

1. **Rozpoznać typy i ścieżki wcześnie.** Sporządzić capabilities matrix dla JDG, spółek/osób prawnych, jednostek i pozostałych wymaganych podmiotów. Dla każdego wskazać dane z przygotowania, dane portalu, wymagane dane ręczne i brakujące dowody. Rozpoznanie rozpocząć już przy fundamentach.
2. **Ustalić definicję zgodnego podmiotu.** Porównanie zweryfikowanych identyfikatorów i nazwy, reguły osoba–firma i jednostka lokalna. Podobna nazwa albo osoba decyzyjna nie zastępują potwierdzenia. Wyniki mismatch/ambiguous/unsupported_capability rozdzielone i czytelne.
3. **Zaprojektować Identity V2.** Dodać wspólny kontrakt core, walidatory i fixtures wszystkich wariantów. V1 pozostaje odczytywalne dla istniejących runów; brak wersji nie jest automatycznie V2. Zmiana wymaga zgodności producenta i konsumenta.
4. **Migracja i API.** Rozszerzyć `RunIdentity`/payload na typ i firmowe identyfikatory, warunkową obecność danych osoby, wersję i evidence. Dla starych JDG jawny backfill V1/type. Nie przechowywać pustego/fikcyjnego PESEL dla spółki. Worker results i eksport otrzymują V2 z walidacją odpowiednią dla typu.
5. **Resolver/adapter Everest.** Dodać warianty kandydatów oraz strategię dopasowania. Search czyta wynik po aktualnym zapytaniu, odrzuca stary REGON i niepełny candidate. Wielu kandydatów prowadzi do review. Poprawny PESEL sprawdzany tylko na ścieżce osoby.
6. **Strategie Compensy.** Oddzielić przygotowanie formularza JDG/spółki/pozostałych. Zweryfikować wybór typu ubezpieczającego i rzeczywisty schemat danych. Zachować zgodne prefilled identity; nie nadpisywać obcych danych, nie używać numeru rejestracyjnego fixture jako produkcyjnego. Wymagany powiat wybierany z istniejących opcji, bez domysłu.
7. **Warunki gotowości i oczekiwanie.** Każdy ekran: allowed origins, właściwy podmiot/sprawa, gotowy element, zakończony request oraz timeout. Dodać obronę przed overlay/wolnym AJAX/SSO expiry/zmianą selektora. Fixed sleep nie jest dowodem gotowości; pacing jest dodatkowym ograniczeniem.
8. **Pacing portali.** Jeden właściciel profilu; konfigurowalne odstępy istotnych akcji i wspólny cooldown profilu. Nie spowalniać każdego zasobu strony. Po wait ponownie sprawdzić desired control, grant, deletion i lease. Liczby odstępów są konfiguracją do odbioru, nie oficjalnym limitem portalu.
9. **Bramka skutków zewnętrznych.** Przed tworzeniem/zapisem/UFG utrwalić intent i własność; przed kliknięciem ponownie sprawdzić zgodność. Po wyniku zapisać potwierdzenie i reference. Timeout po wysłaniu daje sent_uncertain; brak dowodu nie może być interpretowany jako „nie wykonano”.
10. **Odzyskanie sprawy po nowej sesji.** W obecnym saverze lookup opiera się na bieżącym ekranie. Dodać nawigację do utrwalonego caseReference oraz odczyt potwierdzonego stanu na świeżej sesji. Sprawdzić zgodność podmiotu/reference. Brak możliwości odnalezienia daje manual_required, a nie ponowne tworzenie.
11. **Lease i właściciel profilu.** Potwierdzić spójność advisory profile lock, execution lease i worker session/generation. Przy utracie własności zatrzymać kolejne działania i zamknąć własny browser. Nowy właściciel nie startuje drugiej aktywnej instancji profilu bez rozstrzygnięcia starej. Lease nie cofa już wysłanej akcji i nie zastępuje reconcile.
12. **Retry i restart.** Read-only kroki mogą mieć ograniczone retry; rezultat dostarczyć ze stagingu bez ponownego UFG. Recovery czyta checkpoint i wybiera dokładny etap; nie zaczyna flow od początku. Niepewna akcja wymaga reconcile lub interwencji. Zaktualizować transitions/error codes i run recovery intents.
13. **Odczyt UFG.** Właściwa sprawa/tożsamość, kompletna tabela/paginacja/virtualization, total count, source order i daty. Warianty podmiotów produkują ten sam kontrakt polis, z właściwą identity. Niepełny wynik nie staje się wynikiem zerowym.
14. **Kontrakty wyjścia.** Osobno worker→syntetyczny odbiornik V2 i API/export→syntetyczne V1/V2; brak obligatoryjnego decrypt PESEL dla spółki. Snapshot wejścia punktu 4 i identity evidence muszą identyfikować te same dane przygotowania.
15. **Odbiór adapterów.** Oddzielne fixture browser dla resolvera, formularza, saver/reconcile, UFG i sesji. Liczniki operacji oraz fault injection. Sporządzić wynik dla każdego typu z capabilities matrix; dopiero późniejszy odbiór użytkownika potwierdza rzeczywisty portal.

## Punkty odbioru

| ID | Kryterium |
| --- | --- |
| A01 | Każdy wymagany typ ma jawny kontrakt, strategię i wynik testu; unknown nie uruchamia skutków. |
| A02 | Zero błędnych powiązań firmy/osoby/jednostki w zestawie fixture. |
| A03 | Spółka nie wymaga fikcyjnego PESEL; API, staging i eksport obsługują właściwy wariant. |
| A04 | V1 historycznych JDG pozostaje odczytywalne i nie zmienia znaczenia. |
| A05 | Stary wynik/obca sprawa/niepełny ekran blokuje akcję i daje interwencję. |
| A06 | Timeout po Save/UFG prowadzi do reconcile/manual_required, bez automatycznego drugiego skutku. |
| A07 | Sprawę można odzyskać po świeżym logowaniu albo jawnie wskazać nierozstrzygniętą blokadę. |
| A08 | Utrata lease/grantu/control nie pozwala na kolejne kontrolowane akcje ani lokalne zapisy. |
| A09 | Wynik kompletny i właściwy typ identity; retry result_delivery nie wraca do UFG. |
| A10 | Pełny wymagany zakres pozostaje nieodebrany, jeśli choć jeden wymagany typ ma tylko unsupported. |

## Testy i ograniczenia dowodu

JDG poprawna/bez PESEL/dwie osoby; spółka bez reprezentanta oraz z rzeczywiście wymaganym reprezentantem; jednostka lokalna; podobne nazwy; stary search result. Crash przed intent, po intent przed click, po click przed response, po response przed DB; fresh browser; selector missing; lease loss; dwa procesy; zły caseReference; niepełna tabela; błędne dane osoby.

Używać modułów everest-browser, compensa-browser i ufg-browser osobno. Testy kontraktów nie łączą ich w pełne flow. Nie obiecywać exactly-once na zewnętrznym portalu bez jego idempotencji. Lokalnie wymuszamy trwałą kontrolę, brak bezwarunkowego ponowienia i jawne niepewności.

Przekazanie: capabilities matrix, Identity V2 schema/migracje, selectors/version manifest, recovery decision table, liczniki i wyniki fixture. Brak selektora/ścieżki live wymieniony w protokole; nie ukryty pod statusem ogólnego PASS.
