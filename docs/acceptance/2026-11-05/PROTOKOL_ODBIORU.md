# Protokół pełnego odbioru Goldis — wzór do wypełnienia

Status początkowy: **NIEWYPEŁNIONY / ODBIÓR NIEZAKOŃCZONY**. Utworzenie tego pliku nie zalicza żadnego testu.

## 1. Identyfikacja

| Pole | Wartość |
| --- | --- |
| RunId / data i strefa czasu | DO UZUPEŁNIENIA; Europe/Warsaw dla terminów odbioru |
| Klient / zakres | Jedna firma, 2–5 pracowników; identyfikator organizacji bez danych osób |
| Release / pełny SHA | DO UZUPEŁNIENIA |
| Manifest i checksumy paczki | DO UZUPEŁNIENIA |
| Obrazy po digestach | PostgreSQL, własny Redis ACL, API, commission-engine, portal-worker, web; zgodnie z rzeczywistym scope |
| Migracja / granty / kontrakty | Faktyczny head i hashe; obecnie plan obejmuje066 i kontrakt Node/Python |
| A: testowy Linux/HTTPS | Identyfikator środowiska i konfiguracji |
| B: VPS/origin | Dokładny host/origin i konfiguracja; bez haseł/IP prywatnych w publicznym raporcie |
| Seed / dane referencyjne | Wersja/hash; oczekiwany wynik OC i prowizji |
| Źródło bieżących wyników | Wskazać właściwy wyniki.csv lub strukturalny rejestr executions; nie prowadzić sprzecznych kopii |
| Prowadzący / operator / klient | Osoby i role, bez danych uwierzytelniających |

## 2. Dokładny zakres dopuszczenia

- [ ] OC: przygotowanie i wyniki.
- [ ] OC: portale LIVE na odebranym profilu i koncie.
- [ ] Prowizje: upload, słownik, analiza, historia i eksport.
- [ ] MF VAT: odebrany kontrolny lookup i limit/cache.
- [ ] Odzyskiwanie hasła przez mail albo wskazana alternatywa administracyjna.
- [ ] Przeniesiono istniejące dane albo jawnie wybrano czystą instalację.
- [ ] Niedopuszczone funkcje są technicznie wyłączone, a ich wpływ na runtime/schemat/backup sprawdzony.

Ograniczenia i N/A: **DO UZUPEŁNIENIA**. Ukrycie menu nie jest samo w sobie blokadą API lub wyłączeniem migracji/usługi.

## 3. Wyniki według faz i bramek

| Faza / bramka | Wymagane przypadki i warianty | PASS | FAIL | BLOCKED / INCONCLUSIVE / NOT_RUN | N/A z uzasadnieniem | Dowód |
| --- | --- | --- | --- | --- | --- | --- |
| A, G0–G2: scope/kod/DB | DO UZUPEŁNIENIA | — | — | — | — | — |
| A, G3: procesy obu narzędzi | DO UZUPEŁNIENIA | — | — | — | — | — |
| A, G4: bezpieczeństwo | DO UZUPEŁNIENIA | — | — | — | — | — |
| A, G5: runtime/DR/obciążenie | DO UZUPEŁNIENIA | — | — | — | — | — |
| B, G6: końcowy host | DO UZUPEŁNIENIA | — | — | — | — | — |
| LIVE/UAT, G7 | DO UZUPEŁNIENIA | — | — | — | — | — |
| B/UAT, G8: przekazanie | DO UZUPEŁNIENIA | — | — | — | — | — |

Grupa SEC zawiera warianty endpoint/rola/zasób/stan; jeden pozytywny request nie zalicza całej grupy. Wynik A nie przenosi się automatycznie do B.

## 4. Bezpieczeństwo i usterki

| FindingId | Potwierdzony wpływ / poziom | Dotknięty scope | Poprawka i SHA | RetestId / dowód | Stan / właściciel / termin |
| --- | --- | --- | --- | --- | --- |
| DO UZUPEŁNIENIA | — | — | — | — | — |

- [ ] Brak nierozstrzygniętej krytycznej lub osiągalnej wysokiej luki.
- [ ] Brak nieautoryzowanego odczytu/mutacji, mylnej tożsamości, błędnego wyniku prowizyjnego i niekontrolowanego duplikatu skutku portalowego.
- [ ] Wyniki skanów rozstrzygnięte z datą/narzędziem/bazą; false positive lub nieosiągalność mają dowód.
- [ ] Akceptacja niższego ryzyka ma właściciela, uzasadnienie, ograniczenie ekspozycji i termin; nie zmieniła FAIL na PASS.
- [ ] Wszystkie istotne zmiany po pierwszym przebiegu mają zaktualizowany manifest i właściwy retest.

## 5. Kopie, odzyskiwanie i utrzymanie

| Pomiar / ustalenie | Wymaganie | Actual i dowód |
| --- | --- | --- |
| RPO danych biznesowych | ≤24 h, definicja punktu odcięcia zapisana | DO UZUPEŁNIENIA |
| RTO platformy | ≤8 h, początek/koniec scenariusza zapisany | DO UZUPEŁNIENIA |
| Aktualność journala poza hostem | Znane okno i brak odtworzenia skasowanych danych | DO UZUPEŁNIENIA |
| Cold restore na drugim hoście | Udany odczyt danych/kluczy/plików obu narzędzi | DO UZUPEŁNIENIA |
| Kwarantanna i stare zadania | Brak niepożądanych wiadomości, reset linków i niepewnych powtórzeń | DO UZUPEŁNIENIA |
| Przerwa podczas kopii | Zmierzona i zaakceptowana | DO UZUPEŁNIENIA |
| Przechowywanie danych/kopii | Bez automatycznego TTL do uprawnionego usunięcia | DO UZUPEŁNIENIA |
| Dyżur / zastępca / alarmy | Potwierdzona dostawa i procedura reakcji | DO UZUPEŁNIENIA |
| Cele obciążenia | 5 osób + uzgodniony wolumen/oba narzędzia | DO UZUPEŁNIENIA |
| Aktualizacje / rollback | Procedura, okno i zgodne obrazy/paczka recovery | DO UZUPEŁNIENIA |

Profil/cookies portali nie są zwykłą częścią archiwum platformy. Czas nowego logowania/MFA i rozstrzygnięcia niepewnych runów zapisać osobno od gotowości panelu.

## 6. Odbiór użytkowników

- [ ] Nowy pracownik, doświadczony pracownik i menedżer przeszli właściwe zadania.
- [ ] Rozumieją różnicę: zakończona partia / dodatni wynik / poprawne zero / pominięcie / błąd / niepewny zapis.
- [ ] Znają zakres pauzy/cancel na poziomie runu, submission i całego importu.
- [ ] Starter-only SMS/korekty i procedura nieobecności są wykonalne; assignee nie otrzymuje niejawnie dodatkowych praw.
- [ ] Wyniki i pliki porównano z uzgodnioną referencją; statusy/procenty prowizyjne i wersje słownika są poprawnie rozumiane.
- [ ] Przekazano instrukcje, kanał zgłoszeń, operatora i dostęp awaryjny bez publikowania sekretów.

Uwagi klienta i zaakceptowane ograniczenia: **DO UZUPEŁNIENIA**.

## 7. Decyzja

Wybrać jedną wartość: `NO_GO` / `PILOT_NADZOROWANY` / `ODEBRANY_ZAKRES_OGRANICZONY` / `ODEBRANA_CALOSC_ZADEKLAROWANEGO_ZAKRESU`.

**Decyzja: NIEPODJĘTA.** Zakres, warunki, data uruchomienia i ewentualny termin ponownego odbioru: **DO UZUPEŁNIENIA**.

| Rola | Potwierdzenie / data |
| --- | --- |
| Prowadzący QA | DO UZUPEŁNIENIA |
| Osoba od bezpieczeństwa | DO UZUPEŁNIENIA |
| Operator / zastępca | DO UZUPEŁNIENIA |
| Właściciel produktu / klient | DO UZUPEŁNIENIA |

Załączniki: manifest, indeks dowodów, wyniki, usterki/ryzyka/retesty, protokół restore, obciążenie, UAT, zakres LIVE i instrukcje utrzymania. Żaden podpis nie zastępuje brakującego wyniku testu.

## Wykonanie techniczne 6 listopada 2026 — odbiór nadal otwarty

Przeprowadzono poprawki i lokalne testy opisane w [raporcie realizacji](../../REALIZACJA_ODBIORU_2026-11-06.md). Źródłem aktualnych statusów jest wyniki.csv; komponentowe PASS i pełne npm test nie zaliczają samodzielnie faz A/B/LIVE/UAT. Nie podpisano protokołu i nie dopuszczono instalacji produkcyjnej w imieniu klienta.

Pozostają: działający pełny stos Docker/Linux i obrazy, PG17/Redis, cold restore/offsite z pomiarem RPO/RTO, połączone E2E i obciążenie, odbiór VPS/domeny/proxy/alarmów oraz LIVE/UAT. Manifest snapshotu: ../2026-11-06-final/manifest.json.
