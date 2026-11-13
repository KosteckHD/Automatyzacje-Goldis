# Decyzje wdrożeniowe do uzupełnienia

Utworzono 16 października; uzupełniono przy przygotowaniu planu pełnego odbioru rozpoczętego 5 listopada 2026. Wartości wymagają potwierdzenia przez właściciela wdrożenia przed etapem, który ich potrzebuje. Ten rejestr celowo nie zawiera sekretów ani danych klientów. Nie zakłada hosta ani konfiguracji na podstawie ustawień developerskich. Aktualne bramki i sposób zapisu decyzji opisuje [pełny plan odbioru](../PLAN_PELNEGO_ODBIORU_PLATFORMY_2026-11-05.md); historyczne numery PROD pozostają odwołaniem do starszego planu.

| Decyzja | Wartość | Właściciel / termin | Blokuje |
| --- | --- | --- | --- |
| Docelowe środowisko i host | `DO USTALENIA` | operator przed PROD-09 | PROD-09, PROD-10, PROD-13, PROD-14 |
| Publiczny origin aplikacji oraz polityka TLS/DNS | `DO USTALENIA` | operator/platforma przed PROD-09 | PROD-09, PROD-11, PROD-13 |
| Operator wdrożenia i kontakt awaryjny | `DO USTALENIA` | właściciel produktu przed PROD-10 | PROD-10, PROD-14 |
| Oczekiwane obciążenie, równoległość i okres szczytowy | Potwierdzone: jedna firma, 2–5 pracowników; wolumen firm/analiz i szczyt `DO USTALENIA` | właściciel produktu przed pomiarem LOAD | PROD-11 / G5 |
| RPO | ≤24 h według zapisanych ustaleń12.10; sposób pomiaru i osiągnięcie do potwierdzenia | właściciel/operator przed DR | PROD-10 / G5 |
| RTO | ≤8 h według zapisanych ustaleń12.10; początek/koniec pomiaru i osiągnięcie do potwierdzenia | właściciel/operator przed DR | PROD-10 / G5 |
| Zewnętrzny cel kopii, retencja i właściciel dostępu | Cel/dostęp `DO USTALENIA`; brak automatycznego TTL danych i historii kopii do uprawnionego usunięcia według ustaleń12.10 | operator przed DR | PROD-10 / G5 |
| Kanał alertów i odbiorcy dyżurni | `DO USTALENIA` | operator przed PROD-11 | PROD-11 |
| Provider/źródło danych rejestru i limit wywołań | `DO USTALENIA` | właściciel produktu przed aktywacją | PROD-11, PROD-13 |
| Zakres i termin aktywacji każdego portalu live | `DO USTALENIA` | użytkownik/operator przed PROD-13 | PROD-13, PROD-14 |
| Zakres narzędzi i aktualnego schematu | W drzewie OC + rzeczywiste prowizje, migracja066, 6 obrazów/12 usług; manifest ma potwierdzić końcowy zakres i ewentualne techniczne wyłączenie funkcji | właściciel/programista przed G0–G2 | G0–G8 |
| Źródło historycznych obrazów, digestów, konfiguracji i schematu | `NIE ODNALEZIONO W TEJ WERYFIKACJI` | operator/inżynieria przed zgodnością historyczną | PROD-00, PROD-10, PROD-12 |

Decyzje należy zapisać bez danych uwierzytelniających. Sekrety trafiają wyłącznie do zatwierdzonego managera sekretów, a do raportów można wpisać identyfikator odwołania. Do PROD-14 trzeba dołączyć identyfikator wersji źródła, digesty obrazów, nazwę instalacji oraz wynik odbioru operatora.
