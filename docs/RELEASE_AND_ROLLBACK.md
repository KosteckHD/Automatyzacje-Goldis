# Wydanie i rollback

## Skład release

Każdy release musi wskazywać czysty commit, z którego zbudowano wszystkie obrazy. Wartości `GOLDIS_BUILD_VERSION`, `GOLDIS_BUILD_COMMIT` i `GOLDIS_IMAGE_DIGEST` przekazywane do API są publicznymi identyfikatorami; endpoint admina odczytuje je przez `runtimeBuildManifest`. Digestów nie wpisuje się do kodu obrazu jako samoodniesienia.

Do rekordu wydania dołącz:

- digesty PostgreSQL, Redis, API, workera Playwright i web;
- commit, wersję, najwyższą migrację i SHA-256 pliku grantów PostgreSQL;
- wersje konfiguracji Compose/Nginx/seccomp i checksumy niesekretnych plików konfiguracyjnych;
- wynik builda, `npm test`, testów modułowych, smoke UI/HTTP i odbioru integracyjnego;
- aktualny status backupu, head dziennika kasowań, readiness, zakres odbioru i osobę operatora.

Po czystym commicie i opublikowaniu prawdziwych digestów utwórz początkowy manifest poza repo:

```sh
npm run release:manifest -- --env /etc/goldis/env.production \
  --output /var/lib/goldis/releases/<wersja>/release-manifest.json
```

Generator odrzuca brudny working tree, niezgodny pełny SHA commita, ruchome tagi i digest API inny niż obraz. Pola walidacji w nowym manifeście zaczynają się od `pending`; zmień je dopiero po zapisaniu dowodu odpowiedniego etapu. Nie oznaczaj pominiętego odbioru jako PASS.

Nie zapisuj wartości sekretów, danych klientów, haseł, tokenów, PESEL-u, loginów portalowych ani zawartości logów. `runtime-manifest.ts` filtruje build identyfikatory do bezpiecznego formatu; pole `imageDigest: null` oznacza, że runtime nie zgłosił prawidłowego digestu.

## Wdrożenie

1. Zamroź nową pracę i potwierdź, że stan repo jest czysty oraz release obejmuje wszystkie oczekiwane pliki.
2. Zbuduj i opublikuj digesty z commita. Uruchom pełną macierz testów i `node scripts/validate-production-compose.cjs --env /etc/goldis/env.production`.
3. Wstrzymaj nowe przyjęcia w Nginx i zatrzymaj workerów po bezpiecznym zakończeniu aktywnych kroków. Pozostaw DB dostępne do kopii.
4. Wykonaj kopię zaszyfrowaną oraz oddzielny aktualny backup dziennika kasowań. Uruchom `verify.sh` dla obu plików. Produkcyjne RPO/RTO nie są potwierdzone, dopóki nie zostanie zmierzony pełny restore poza hostem.
5. Wdróż nowe zmienne obrazu jako digesty, uruchom migracje i `apply-runtime-grants`, sprawdź health oraz `runtime-check.cjs`. Przywróć ruch po smoke HTTPS, ról, uploadu/pobrania i potwierdzeniu bezpiecznej kolejki.
6. Zapisz protokół z dokładnymi commitami i digestami. Nie nadpisuj wcześniejszego protokołu release.

## Rollback

1. Zatrzymaj nowe przyjęcia. Zachowaj worker staging, run checkpointy, audit/run events i najnowszy deletion journal.
2. Sprawdź zgodność poprzedniego API/workerów ze schematem po migracjach. Przełączenie digestu nie cofa migracji ani danych. Wsteczna kompatybilność musi być jawnie opisana dla każdej zmiany schematu.
3. Jeśli migracja była rozszerzająca i poprzednia wersja jest kompatybilna, ustaw digesty poprzedniego sprawdzonego release, uruchom runtime granty, a potem smoke readiness i dostawy wyników. Pozostaw portal-workera wyłączonego do potwierdzenia checkpointów.
4. Jeśli migracja zmienia lub usuwa dane albo zgodność jest nieznana, nie przełączaj samych obrazów. Odtwarzaj w nowym projekcie i pustych wolumenach według `deploy/backup/restore.sh`, zawsze z najnowszym zweryfikowanym journalem. Porównaj syntetyczne wyniki i runy przed otwarciem ruchu.
5. Nie ustawiaj runów na `completed`, nie czyść checkpointów i nie ponawiaj niepewnych akcji zewnętrznych jako metody naprawy.
6. Po odzyskaniu systemu zapisz przyczynę, digesty, hash journala, listę wykonanych kroków i zmierzone czasy. Usuń środowisko kwarantanny dopiero po osobnym przeglądzie; automatyczne kasowanie jest celowo wyłączone.

Test rollbacku na syntetycznej bazie powinien obejmować wynik, cudzy przydzielony lead, oczekującą dostawę i kasowanie po backupie. Do czasu uruchomienia izolowanego Docker Engine weryfikacja ta pozostaje niezaliczona.
