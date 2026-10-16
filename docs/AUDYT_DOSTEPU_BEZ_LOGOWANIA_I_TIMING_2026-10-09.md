# Audyt dostępu bez logowania i czasu weryfikacji hasła

Data: 2026-10-09. Zakres: lokalny kod platformy i automatyzacji, API, produkcyjny build Next.js, sesje, pobieranie danych i weryfikacja hasła. VPS jeszcze nie istnieje — zgodnie z informacją użytkownika. Nie badano publicznej domeny ani konfiguracji przyszłego reverse proxy.

## Ocena

**Nie znaleziono dostępu do danych klienta bez aktywnej sesji przez zbadane trasy aplikacji. Znaleziono potwierdzony kanał czasowy pozwalający rozpoznawać konta ze starym formatem hasha, jeżeli takie konta pozostają w bazie. Audyt nie daje jeszcze zgody na uruchomienie całej platformy z rzeczywistymi danymi na VPS.**

Nie wykazano możliwości odgadywania kolejnych znaków hasła na podstawie czasu odpowiedzi. Samo rozróżnienie udanego i nieudanego logowania jest oczekiwane: udane logowanie wydaje sesję, nieudane ją odrzuca. Istotny problem dotyczy różnic pomiędzy próbami, które wszystkie kończą się błędem.

Raport uzupełnia [szerszy audyt poufności na VPS](C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/AUDYT_POUFNOSCI_DANYCH_VPS_2026-10-09.md). Wskazane tam kwestie przechowywania eksportów, uprawnień bazy, sekretów, izolacji workera i kopii zapasowych pozostają otwarte.

## Dostęp anonimowy: wyniki testów

| Sprawdzenie | Wynik |
|---|---|
| Inwentaryzacja kontrolerów rzeczywistego `AppModule` | 100 tras: 93 chronione i 7 publicznych |
| 8 wariantów nieprawidłowej/brakującej sesji na każdej chronionej trasie | 744 odpowiedzi 401/403; brak danych testowych |
| Czy odmowa następuje przed uruchomieniem usług biznesowych | 0 wywołań usług przed kontrolą pozytywną |
| HEAD na chronionych trasach GET | 49 odmów, pusta treść odpowiedzi |
| Aktywna, poprawna sesja — kontrola pozytywna | 200 i prywatny znacznik testowy |
| Wylogowanie, następnie brak cookie i powtórzenie zapisanego tokenu | 401 w obu przypadkach |
| Stan sesji po stronie serwera: zablokowany użytkownik, odebrane członkostwo, zmieniona rewizja hasła, termin ważności w bazie, 31 minut bez aktywności | 401 w każdym z 5 przypadków, pomimo poprawnie podpisanego cookie |
| Niedostępna baza podczas weryfikacji sesji | 503 i brak danych; brak obejścia uwierzytelniania |
| Te same chronione trasy przez rewrite Next.js | 93 odmowy 401/403 |
| Świeży kontekst Chromium, 12 widoków | `/api/auth/me` zwraca 401; ekran logowania/odmowy; brak prywatnego znacznika |
| Bezpośredni odbiornik kodów workera | 3 odmowy 401: bez sekretu, z błędnym sekretem, z tokenem sesji użytym jako sekret |
| Próby standardowych ścieżek plików przez Next.js | `.env`, `.git/config`, `exports`, `uploads`, `artifacts`, `docs`: 404 dla 6 badanych adresów |
| Cache-Control na badanych odpowiedziach API i stronach | `private, no-store` |

Warianty sesji: brak cookie, puste cookie, niepoprawny format, zmieniony podpis, wygasły token, podpisany token bez aktywnego wpisu w rejestrze sesji, stary token bez identyfikatora sesji, podrobione nagłówki tożsamości i roli wraz z tokenem w `Authorization`. W żądaniach mutujących podano poprawny origin i nagłówek CSRF, aby nie polegać wyłącznie na wcześniejszej odmowie CSRF.

Zbadane trasy obejmują m.in. importy i wiersze Excela, eksporty i pobieranie wyników, przygotowania, przebiegi automatyzacji, zadania wzbogacania, interwencje, kody autoryzacji, raporty, audyt i administrację. Pełna lista tras i każdej z 744 prób znajduje się w pliku dowodowym.

W przeglądarce sprawdzono `/`, `/account`, `/admin`, `/audit`, `/imports`, szczegóły importu, `/results`, `/review`, `/runs`, szczegóły przebiegu, szczegóły zgłoszenia i `/tools/oc-policy-verification`. Publicznie dostępna powłoka HTML pokazująca logowanie nie oznacza dostępu do danych Excela; pobieranie danych wymaga sesji po stronie API.

Publiczne trasy to logowanie, wylogowanie i pięć endpointów health. Przegląd implementacji oraz odpowiedzi testowe nie wykazały danych klientów w health. Endpointy automation/enrichment ujawniają jednak stan usług i konfiguracji, więc warto ograniczyć je na publicznym reverse proxy do monitoringu wewnętrznego.

Mechanizm sesji weryfikuje podpis HMAC, termin ważności tokenu, obecność sesji w bazie, jej unieważnienie, czas bezczynności, aktywność użytkownika, rewizję poświadczeń i aktywne członkostwo. Rola pochodzi z bazy. [Implementacja sesji](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/session.ts:121).

## Potwierdzone ustalenie T-01: różnica czasu dla starych hashy

**Priorytet: średni; do usunięcia przed publicznym udostępnieniem logowania, jeżeli pozostają konta legacy.** Warunek wystąpienia wynika z obsługi obu formatów hasha; nie sprawdzano liczby starych kont w rzeczywistej bazie.

Stary format `scrypt$salt$key` jest weryfikowany przy `N=16384`. Aktualny format `scrypt$v1$N=131072,r=8,p=1$...` oraz pozorna weryfikacja nieistniejącego użytkownika używają `N=131072`. Kod podnosi koszt starego hasha dopiero po udanym logowaniu. Błędne hasło pozostawia szybszą ścieżkę. [Parametry i weryfikacja](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/password-hash.ts:89), [aktualizacja po poprawnym haśle](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/session.ts:280).

Pomiar lokalnego HTTP: 2 rundy rozgrzewki, następnie 16 próbek na scenariusz, losowa kolejność, żądania kolejno, błędne hasła o jednakowej długości. Czas obejmuje otrzymanie całej odpowiedzi. Wyniki ostatniego przebiegu:

| Scenariusz | Mediana ms | p10–p90 ms |
|---|---:|---:|
| Nieistniejący login, błędne hasło | 284,67 | 257,85–355,85 |
| Aktualny hash, 0 zgodnych początkowych znaków | 283,03 | 264,62–318,61 |
| Aktualny hash, zgodna połowa początkowych znaków | 284,93 | 261,06–312,77 |
| Aktualny hash, błędny tylko ostatni znak | 274,90 | 263,03–333,81 |
| **Stary hash, błędne hasło** | **35,23** | **32,99–42,70** |
| Zablokowane konto z aktualnym hashem, błędne hasło | 278,46 | 262,32–394,74 |
| Aktualny hash, poprawne hasło | 292,23 | 258,84–359,56 |

Wszystkie mierzone nieudane próby zwróciły identyczny status 401 i treść błędu oraz nie wydały cookie sesji. Pomimo tego stary hash odpowiadał około 8 razy szybciej niż nieistniejące konto. Wcześniejszy przebieg dał około 31 ms wobec 250 ms, co potwierdza powtarzalność kierunku różnicy przy zmieniającym się obciążeniu komputera. Nie oszacowano skuteczności ataku przez Internet z aktywnym limiterem.

Skutek: możliwość rozpoznania loginu konta korzystającego ze starego formatu i ułatwienie doboru celów do dalszych prób. Ten pomiar **nie ujawnił hasła ani liczby jego poprawnych znaków**. Wyniki trzech błędnych haseł dla aktualnego formatu nie wykazują rosnącego czasu wraz z poprawnym prefiksem. Próba 16 pomiarów na scenariusz nie wyklucza wszystkich subtelnych kanałów czasowych ani różnic wynikających z prawdziwej bazy lub równoległego obciążenia.

Kod najpierw oblicza scrypt dla całego hasła, a następnie porównuje 64-bajtowy wynik przez `timingSafeEqual`; nie porównuje jawnego hasła znak po znaku. Dokumentacja Node opisuje stały czas samego porównania, ale zaznacza, że otaczająca logika może nadal wprowadzać kanały czasowe. [Dokumentacja Node](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b).

Identyczny komunikat błędu jest potrzebny, ale nie usuwa różnicy w koszcie obliczeń. OWASP zaleca ogólne odpowiedzi na błędne logowanie i wskazuje różnice czasu jako źródło ujawniania istnienia kont. [OWASP Authentication Responses](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-responses).

Zalecana naprawa: przed wdrożeniem policzyć stare formaty bez ujawniania hashy w logach. Najprostsze zamknięcie ryzyka to przeprowadzić bezpieczną zmianę/reset haseł starych kont, a następnie wyłączyć obsługę legacy. Jeśli zgodność ze starymi kontami musi zostać zachowana, należy zaprojektować jednakowy profil pracy kryptograficznej wszystkich nieudanych ścieżek i ponownie zmierzyć istniejące, nieistniejące, zablokowane i uszkodzone konta. Samo zwiększenie `N` przy odczycie starego hasha uniemożliwi poprawne sprawdzanie dotychczasowych haseł. Sam losowy sleep nie usuwa źródła kanału.

Limiter działa przed weryfikacją hasła. W osobnym, wcześniejszym teście rzeczywistego Redis potwierdzono limit pary login/IP 5, limit IP 60 i `Retry-After`. [Log Redis](C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/security/security-redis-2026-10-09.log). Obecny pomiar czasu korzystał z limitera testowego, aby zmierzyć KDF; ograniczenia liczby prób zmniejszają wykonalność rozpoznawania kont, lecz nie naprawiają różnicy w KDF.

## Warunki odbioru VPS przed użyciem danych klientów

1. Ustawić `APP_ENV=production`, poprawny `PUBLIC_APP_ORIGIN=https://...` i HTTPS na reverse proxy. W obecnym Compose domyślne środowisko API to development; `Secure` na cookie sesji zależy od `NODE_ENV=production`. Nie wolno zakładać, że lokalna konfiguracja sama tworzy właściwy profil VPS. [Compose](C:/Users/micha/Desktop/Goldis-Automatyzacje/compose.yaml:42), [cookie](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/session.ts:338).
2. Publiczny ruch kierować przez reverse proxy do web; dostęp do PostgreSQL, Redis, workera i bezpośredniego portu API ograniczyć do sieci wewnętrznej/loopback. Obecne hostowe porty Compose są przypięte do loopback. Potwierdzić faktyczny stan portów i reguł sieciowych z zewnątrz dla IPv4 i IPv6 po wdrożeniu, uwzględniając publikowanie portów przez Docker.
3. Nie montować eksportów, źródłowych Exceli, stagingu, profili przeglądarki, backupów ani `.env` do `public`, katalogu serwowanego przez nginx/Caddy lub publicznego storage. Zakazać aliasów i listowania takich katalogów. Test nieistniejącego `/exports/file.xlsx` nie dowodzi, że przyszły alias proxy nie udostępni rzeczywistego eksportu. Odbiór musi sprawdzić istniejący syntetyczny plik.
4. Wyłączyć współdzielone cache dla odpowiedzi prywatnych i API na proxy/CDN. Zachować `private, no-store`. Sprawdzić scenariusz: pobranie danych przez zalogowane konto, następnie identyczny URL bez sesji; nie może zwrócić poprzedniej odpowiedzi z cache.
5. Ustawić `TRUST_PROXY_IPS` wyłącznie na rzeczywiste, zaufane adresy proxy i uporządkować przekazywanie IP klienta przez wszystkie pośredniki, w tym Next.js. Przetestować limiter z różnych klientów oraz z podrobionym `X-Forwarded-For`; pomiar lokalny nie sprawdza przyszłego łańcucha proxy.
6. Zablokować z Internetu ścieżki `/api/internal/*` i odbiornik workera na poziomie proxy/sieci, zachowując także uwierzytelnianie sekretem w aplikacji. Ograniczyć szczegółowe health do monitoringu wewnętrznego.
7. Usunąć lub wyeliminować T-01, powtórzyć testy przez rzeczywistą domenę HTTPS i sprawdzić sesję wygasłą, wylogowaną i unieważnioną. Przy przerwanym połączeniu z bazą nadal musi nastąpić odmowa bez danych.
8. Zamknąć warunki szerszego audytu poufności przed przechowywaniem prawdziwych Exceli na VPS. Prawidłowy guard API nie zabezpiecza błędnie wystawionego wolumenu, backupu ani przejętego serwera.

Wylogowanie blokuje kolejne pobrania z serwera. Nie usuwa informacji, które użytkownik wcześniej legalnie pobrał jako plik, skopiował albo zobaczył. Wynik tego audytu dotyczy uzyskiwania nowych danych bez aktywnej sesji, nie zdalnego odebrania uprzednio poznanych danych.

## Dowody, odtwarzanie i ograniczenia

- [Wyniki tras, stanów sesji i surowe czasy](C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/security/anonymous-access-evidence-2026-10-09.json).
- [Log API i timing](C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/security/anonymous-access-audit-2026-10-09.log).
- [Wyniki Next.js i przeglądarki](C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/security/anonymous-web-evidence-2026-10-09.json).
- [Log Next.js](C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/security/anonymous-web-audit-2026-10-09.log).
- [Skrypt API i timing](C:/Users/micha/Desktop/Goldis-Automatyzacje/scripts/audit-anonymous-access-2026-10-09.cjs).
- [Skrypt Next.js](C:/Users/micha/Desktop/Goldis-Automatyzacje/scripts/audit-anonymous-web-2026-10-09.cjs).

Polecenia z katalogu projektu, po zbudowaniu bieżącego API, workera i web (`npm run build`):

```powershell
node scripts/audit-anonymous-access-2026-10-09.cjs
node scripts/audit-anonymous-access-2026-10-09.cjs --web-only
```

Skrypt wykorzystuje rzeczywiste kontrolery, guardy, produkcyjne nagłówki HTTP i implementację scrypt, lecz podmienia usługi biznesowe, ORM i limiter na dane syntetyczne. Kontrola pozytywna dowodzi, że prywatny znacznik jest dostępny przy poprawnej sesji; przy odmowie kontrolowano również brak wywołania usług. Nie odczytuje `.env` ani rzeczywistych Exceli, nie łączy się z bazą klientów i nie wykonuje żądań do portali ubezpieczeniowych.

Test web używa izolowanej kopii istniejącego produkcyjnego `.next`. Tylko w kopii zmienia docelowy adres rewrite na syntetyczne API. Ruch HTTP na localhost służy lokalnej weryfikacji; nie weryfikuje TLS na VPS. Nie zmienia produkcyjnego kodu ani konfiguracji wdrożeniowej.

Te testy nie zastępują testu prawdziwego procesu API ze wszystkimi zależnościami, skanowania infrastruktury, testów obejść reverse proxy ani pełnego pentestu. Osobne wcześniejsze testy PostgreSQL sprawdziły m.in. sesje, role i izolację tenantów: [log integracyjny](C:/Users/micha/Desktop/Goldis-Automatyzacje/docs/security/security-db-2026-10-09.log). Syntetyczne testy nowych tras nie wykrywają automatycznie każdej możliwej ścieżki poza kontrolerami Nest, np. nowego aliasu serwującego pliki.

Kod zakończenia 0 skryptu potwierdza wykonanie kontroli i zebranie pomiarów. **Nie oznacza usunięcia T-01**; wynik `legacyAccountTimingRisk: true` pozostaje zapisany w dowodach. W ramach tego zadania dodano audyt i testy; nie naprawiano mechanizmu logowania.
