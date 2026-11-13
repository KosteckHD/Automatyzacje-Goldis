# Monitoring lokalny — szablon do odbioru na VPS

`check.sh` sprawdza dziewięć usług, istniejące endpointy runtime, wiek zaszyfrowanej kopii i bieżącego journala oraz wolne miejsce. Nie wysyła wiadomości ani nie usuwa danych. Nie zalicza offsite, odtwarzania ani poprawności kolejki prowizji; stan running nie dowodzi postępu zadania. Osobny alarm zewnętrzny musi wykrywać brak odpowiedzi całego hosta.

Przykład `/etc/goldis/monitor.env` (root:root 0600):

```ini
GOLDIS_MONITOR_ENV_FILE=/opt/goldis/.env.production
GOLDIS_MONITOR_BACKUP_DIR=/var/backups/goldis
GOLDIS_RUNTIME_BASE_URL=https://platforma.example.pl
GOLDIS_EXPECT_ENRICHMENT_PROVIDER=mf-vat
GOLDIS_EXPECT_PORTAL_LIVE=0
GOLDIS_MONITOR_MAX_BACKUP_AGE_SECONDS=86400
GOLDIS_MONITOR_MIN_FREE_MB=4096
```

Przed aktywacją dopasuj ścieżki, provider i tryb portali do odebranego zakresu. Ręcznie uruchom skrypt, następnie zainstaluj pliki `.example` w `/etc/systemd/system/` bez końcówki `.example`, wykonaj `systemctl daemon-reload` i `systemctl enable --now goldis-monitor.timer`. Polecenia te wykonuje operator na docelowym hoście, po zatwierdzeniu konfiguracji instalacji.

Skonfiguruj odbiorcę alarmów dla błędu `goldis-monitor.service` i zewnętrzny test HTTPS. Odbiór wymaga kontrolowanego zatrzymania usługi, przeterminowania testowej kopii i sprawdzenia doręczenia oraz reakcji operatora. Tych prób i pomiaru RPO/RTO nie wykonano na VPS. Kluczy dostawcy alertów nie wpisuj w pliki unit ani do repozytorium.
