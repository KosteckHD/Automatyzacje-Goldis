# Goldis — mockupy przebudowy frontendu

24 widoki na 6 planszach. Kolejność na każdej planszy: lewy górny, prawy górny, lewy dolny, prawy dolny.

Koncepcje wygenerowane narzędziem ImageGen, z logo Goldis i zaakceptowanym mockupem dashboardu jako referencjami. Dane są przykładowe. Są to propozycje wizualne, a nie specyfikacja gotowego zachowania ani potwierdzenie stanu usług. Kod aplikacji nie został zmieniony.

Poszczególne etykiety, aktywne pozycje menu i wartości wygenerowane na obrazach wymagają dopracowania przy wdrożeniu. Macierz dostępów w aplikacji ma cztery niezależne prawa: widoczność, uruchamianie, podgląd i pobieranie. Usuwanie danych pozostaje oddzielnym uprawnieniem. Nie należy odtwarzać powielonej kolumny pobierania widocznej na koncepcji 17.

## Start i narzędzia

[Otwórz planszę](01-start.png)

| Nr | Widok | Powiązanie z obecnym frontendem |
|---|---|---|
| 01 | Logowanie | / (widok niezalogowany) |
| 02 | Dashboard | / (przebudowa katalogu w dashboard) |
| 03 | Katalog narzędzi | / (obecny katalog; proponowany osobny widok) |
| 04 | Weryfikacja polis OC | /tools/oc-policy-verification |

## Importy i przygotowanie danych

[Otwórz planszę](02-dane.png)

| Nr | Widok | Powiązanie z obecnym frontendem |
|---|---|---|
| 05 | Historia importów | /imports |
| 06 | Szczegóły importu i przygotowanie | /imports/[id] oraz panel przygotowania |
| 07 | Wzbogacanie NIP → REGON | panel enrichment-review w narzędziu OC |
| 08 | Korekty i konflikty | /review — zakładki korekt i konfliktów |

## Operacje, partie i interwencje

[Otwórz planszę](03-operacje.png)

| Nr | Widok | Powiązanie z obecnym frontendem |
|---|---|---|
| 09 | Historia operacji | /runs |
| 10 | Szczegóły zadania | /runs/[id] |
| 11 | Szczegóły zgłoszenia / partii | /submissions/[id] |
| 12 | Interwencja i kod SMS | centrum interwencji i modal SMS w narzędziu OC |

## Wyniki, audyt i konto

[Otwórz planszę](04-wyniki.png)

| Nr | Widok | Powiązanie z obecnym frontendem |
|---|---|---|
| 13 | Wszystkie wyniki | /results |
| 14 | Szczegóły wyniku | /runs/[id] — proponowany osobny widok wyniku |
| 15 | Dziennik audytu | /audit |
| 16 | Moje konto | /account |

## Administracja: dostęp, konta i działanie

[Otwórz planszę](05-admin.png)

| Nr | Widok | Powiązanie z obecnym frontendem |
|---|---|---|
| 17 | Dostępy do narzędzi | /admin#resources |
| 18 | Konta użytkowników | /admin#accounts |
| 19 | Sesje i bezpieczeństwo konta | /admin#accounts — szczegóły sesji |
| 20 | Centrum operacyjne | /admin#operations |

## Administracja: przydział, ustawienia i raporty

[Otwórz planszę](06-admin.png)

| Nr | Widok | Powiązanie z obecnym frontendem |
|---|---|---|
| 21 | Przydział pracy | /admin#interventions |
| 22 | Ustawienia automatyzacji | /admin#automation |
| 23 | Audyt administracyjny | /admin#audit |
| 24 | Raporty jakości | /admin#reports |


