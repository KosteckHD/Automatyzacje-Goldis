# Audyt bezpieczeństwa Goldis — etap 1, 6 listopada 2026

> Aktualny raport zbiorczy: [audyt i ponowna weryfikacja](../AUDYT_BEZPIECZENSTWA_2026-11-06.md). Kolejność napraw, pliki i kryteria odbioru: [plan implementacji](../PLAN_NAPRAW_BEZPIECZENSTWA_2026-11-06.md). Poniższy opis zachowuje zakres pierwszego etapu; nie obejmuje wszystkich późniejszych ustaleń. Manifest pierwszego etapu jest historyczny; aktualne hashe dowodów zawiera `reverified-manifest.json`.

**Status: audyt rozpoczęty; znaleziono nowy, odtwarzalny problem. Pełny pentest i odbiór produkcyjny pozostają otwarte.** Nie zmieniano kodu aplikacji w ramach tego etapu. Trzy scenariusze wykonano na rzeczywistej skompilowanej klasie CommissionsService z pamięciowymi adapterami, w osobnych procesach. Nie uruchamiano portali, prawdziwej bazy ani operacji na danych klienta.

## Zainstalowane instrukcje i metoda

Źródło: [mukul975/anthropic-cybersecurity-skills](https://github.com/mukul975/anthropic-cybersecurity-skills), commit `54a798831d2266a3ca61ce68a7acb80b81160d57`. To biblioteka społecznościowa. Zainstalowano przez systemowy skill-installer cztery skille w `C:/Users/micha/.codex/skills`:

- `performing-web-application-penetration-test` — powierzchnia wejść, sesje, autoryzacja, walidacja i logika procesu;
- `conducting-api-security-testing` — BOLA/BFLA, CSRF, błędy i kontrakty API;
- `detecting-broken-object-property-level-authorization` — pola przyjmowane i ujawniane przez API;
- `performing-web-application-vulnerability-triage` — odróżnienie potwierdzonego skutku od hipotezy i ocena wpływu.

Treść każdego zainstalowanego SKILL.md porównano SHA256 z uprzednio przeczytaną kopią z tego commita. Instrukcje nie wymusiły użycia przykładowych narzędzi ani ruchu poza zakresem. W tym etapie użyto przeglądu kodu i lokalnych reprodukcji zamiast Burp/DAST. Automatyczne wykrywanie nowych skilli będzie dostępne od następnej wiadomości; ich przeczytana metodologia została zastosowana już teraz.

Zakres przeglądu: kontroler, serwis, repozytorium i modele prowizji; klient i transport Python; zapis plików; wykonawca prowizji; granice uwierzytelniania i autoryzacji. [Mapa 159 tras](route-review.csv) służy jako lista pracy, nie lista zaliczonych testów HTTP. Wcześniejszy [raport przygotowania](../../REALIZACJA_ODBIORU_2026-11-06.md) pozostaje dowodem swojego przebiegu; jego PASS nie zamyka nowych znalezisk.

## Znaleziska

### CYB-001 — modyfikacja Object.prototype przez pole agent

**Waga: średnia. Potwierdzenie: rzeczywisty serwis w izolowanym procesie. CWE-1321 / brak walidacji pola wejścia.**

Wejście: `PATCH /api/tools/commission-comparison/dictionary/drafts/:versionId/entries/:entryId`, pole `agent`. Wymagane są sesja, execute dla prowizji, CSRF oraz osobne prawo edycji słownika lub rola admin. Nie jest to wykazany atak anonimowy.

`commissions.controller.ts` deklaruje `agent` jako unię TypeScript, co nie waliduje JSON w runtime. W `commissions.service.ts:407–410` kod wykonuje `entry.agents[body.agent]`, a następnie zapisuje właściwości otrzymanego obiektu. Brak sprawdzenia `agent` względem Ola/Maciek i brak sprawdzenia własnej właściwości obiektu. Dla `__proto__` rezultatem jest Object.prototype.

Reprodukcja na syntetycznym szkicu słownika: `agent=__proto__`, dozwolony `status=RATE`, `rate=12.5`, właściwa rewizja i istniejący entryId. Wynik: `Object.prototype.status === RATE`, `Object.prototype.rate === 12.5`; niezwiązany nowy obiekt dziedziczył rate. Wywołanie zakończyło się zapisem i audytem. Proces testowy przywrócił prototyp i zakończył działanie.

Wpływ: użytkownik z ograniczonym prawem edycji słownika może zmienić stan wspólny procesu obsługującego inne żądania. Wykazano dziedziczenie zmienionych właściwości. **Nie wykazano RCE, dostępu do obcego tenanta ani przejęcia roli administratora.**

Naprawa: walidować body w runtime, dopuścić wyłącznie dwa znane identyfikatory agenta, sprawdzać własność klucza i istnienie komórki przed mutacją. Zwracać 400 dla `__proto__`, `constructor`, obiektu, tablicy, null i nieznanej nazwy. Retest: prawdziwa ścieżka HTTP z kontem uprawnionym i nieuprawnionym oraz brak zmiany prototypu w obu przypadkach.

### CYB-002 — rewizja szkicu nie chroni atomowo przed równoczesną edycją

**Waga: średnia, wstępna. Potwierdzono zachowanie serwisu; końcowy test PostgreSQL pozostaje wymagany. CWE-362.**

W `commissions.service.ts:398–435` serwis odczytuje rekord, porównuje revision w pamięci, podnosi ją i wywołuje save. Nie przekazuje transakcji, blokady ani warunku CAS na starą rewizję. Model nie ma włączonego mechanizmu optimistic locking Sequelize. Dwie operacje, które odczytały tę samą rewizję, mogą nadpisać sobie zaszyfrowany snapshot.

Reprodukcja z dwoma niezależnymi odczytami revision=1: oba wywołania zostały zaakceptowane, oba zwróciły revision=2 i oba zapisały rekord. Adapter był pamięciowy, więc nie jest to dowód rzeczywistego harmonogramu blokad PostgreSQL ani utraty danych w produkcji.

Wpływ: możliwa utrata zatwierdzonej zmiany stawki, także przy zwykłej równoległej pracy. Naprawa: atomowe UPDATE z tenantId, identyfikatorem, statusem draft i expectedRevision oraz kontrolą jednego zmienionego wiersza, albo transakcja z blokadą rekordu. Audyt i aktualizacja powinny być w tej samej transakcji. Retest DB: dwa różne zapisy tej samej rewizji mają dać dokładnie jeden sukces i jeden 409.

### CYB-003 — zapis stawki następuje przed oddzielnym zapisem audytu

**Waga: średnia, zależna od awarii. Potwierdzono kolejność efektów serwisu; test trwałości PostgreSQL pozostaje wymagany. CWE-778 / integralność audytu.**

W `commissions.service.ts:435–445` save kończy się przed audit.record, bez wspólnej transakcji. W reprodukcji po udanym save adapter audytu zgłosił SYNTHETIC_AUDIT_FAILURE. Operacja zwróciła błąd, ale licznik zakończonych zapisów wynosił 1.

Wpływ: przy błędzie audytu zmiana może zostać utrwalona mimo odpowiedzi błędnej, bez odpowiadającego zdarzenia audytowego. Użytkownik może ponowić operację w błędnym przekonaniu, że nie zaszła. Nie wykazano sposobu wymuszania takiej awarii przez nieuprzywilejowanego użytkownika.

Naprawa: jedna transakcja dla zmiany słownika i audytu; przejrzeć podobną kolejność w deleteFile, cancelRun, addResolution i eksporcie. Retest DB: błąd zapisu audytu musi wycofać rewizję, snapshot i pozostałe zapisy.

## Dowody i odtwarzanie

[Wyniki prób](service-reproductions.json), [skrypt reprodukcji](reproduce-commission-findings.cjs), [manifest źródeł i instalacji](manifest.json), [rejestr znalezisk](findings.json).

```powershell
node docs/security/audit-2026-11-06-skills/reproduce-commission-findings.cjs
```

Skrypt korzysta z istniejącego dist API odpowiadającego badanemu źródłu, sztucznego klucza szyfrującego i adapterów bez DB. Każdy scenariusz działa w osobnym procesie z timeoutem. Nie uruchamia serwera, nie czyta .env ani nie wykonuje żądań sieciowych. Po zmianach w źródłach przed retestem trzeba przebudować API i zachować nowy manifest. Wynik wykazujący podatność nie jest testem akceptacyjnym PASS aplikacji.

## Co jest sprawdzone, a co pozostaje otwarte

W przejrzanych metodach prowizji lookup pliku, szkicu, runu i eksportu zawiera tenantId. Mutacje kontrolera sprawdzają execute/download i CSRF, a zmiany słownika dodatkowo osobny grant. To obserwacja kodu, nie zamknięty test BOLA wszystkich tras.

Wymagane kolejne kontrole:

1. Potwierdzić CYB-001 przez rzeczywisty HTTP i zamknąć poprawkę testem regresji.
2. Potwierdzić CYB-002/003 na izolowanym PostgreSQL, bez danych klienta.
3. Zbadać cofnięcie grantów i wyłączenie konta między przyjęciem a wykonaniem prowizji, wyścig cancel/publikacja snapshotu i ponowne wykonanie zadania kolejki. Obecnie są to obszary przeglądu, nie dodatkowe potwierdzone podatności.
4. Wykonać macierz BOLA/BFLA/CSRF wszystkich 159 tras na syntetycznych kontach i pełnym stosie; uzupełnić pliki, limity i eksporty, a następnie frontend i worker OC.
5. Uzupełnić Docker/Linux, Redis ACL, HTTPS, obrazy i restore zgodnie z planem odbioru. W tym etapie nie odblokowano tych środowisk i nie wykonano testów VPS/LIVE.

**Ocena na dziś:** wcześniejsze zielone suite nie wystarczają do uznania platformy za bezpieczną produkcyjnie. Nowy audyt wskazał konkretną lukę walidacji oraz dwie wymagające domknięcia słabości integralności zmian słownika. Nie podpisano odbioru ani nie zaakceptowano ryzyka w imieniu klienta.
