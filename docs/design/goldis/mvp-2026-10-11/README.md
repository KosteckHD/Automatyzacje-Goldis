# Mockupy Goldis — MVP, 11.10.2026

38 ekranów i stanów platformy, z podziałem na pracownika, menedżera i administratora. Lokalny, klikalny prototyp używa danych przykładowych. Zakres odpowiada [zaktualizowanemu briefowi](PRODUCT.md).

[Plan wdrożenia do platformy](../../../PLAN_IMPLEMENTACJI_MVP_I_REBRANDINGU_2026-10-11.md) zawiera kolejność zmian w danych, API, uprawnieniach i frontendzie, mapę wszystkich 38 mockupów oraz kryteria odbioru.

## Otwieranie

- [Galeria wszystkich mockupów](http://127.0.0.1:3446/gallery.html).
- [Dashboard pracownika](http://127.0.0.1:3446/?role=employee#dashboard).
- [Przydzielanie leadów przez menedżera](http://127.0.0.1:3446/?role=manager#leads) — kliknij „Przydziel leady”.
- [Moje wyniki i statusy kontaktu](http://127.0.0.1:3446/?role=employee#mine).
- [Administracja](http://127.0.0.1:3446/?role=admin#users).

W dolnym pasku prototypu wybierzesz rolę i stronę. Pasek służy do oceny projektu i został ukryty na PNG. Kliknięcie miniatury w galerii otwiera pełny zrzut. Formularze, powiadomienia oraz wartości techniczne są demonstracyjne.

## Najważniejsze ścieżki

**Automatyzacja:** Narzędzia → wgranie Excel → kontrola duplikatów i przygotowanie → opcjonalne uzupełnienie REGON na podstawie NIP → potwierdzenie startu → zadanie → wynik.

**Obsługa firm:** Wyniki → Weryfikacja polis OC → wspólna pula → menedżer przydziela liczbę leadów wybranej osobie → pracownik otwiera Moje wyniki → zapisuje rezultat rozmowy z dropdownu. Przydział nie jest przenoszony między osobami.

**Dostęp:** pracownik ma podgląd wspólnych wyników OC, plików i importów. Osobny grant pozwala uruchamiać automatyzację. Menedżer zarządza kontami pracowników i może przydzielić leady pracownikowi, sobie albo innemu menedżerowi. Administrator ma także widoki konfiguracji, monitoringu i audytu.

Stan przydziału i kontaktu działa w obrębie bieżącego podglądu; odświeżenie przywraca dane demonstracyjne. Excel jest przykładowym plikiem jednej firmy z telefonem i e-mailem. Import oraz API nie są podłączone.

## Pliki

- `public/gallery.html` — galeria 38 PNG, także na telefonie.
- `public/index.html` — klikalny prototyp.
- `public/screenshots/` — pełne obrazy ekranów.
- `src/sidebar.tsx` — adaptacja przesłanego komponentu z zachowaniem kontekstu, API, rozwijania 300/60 px oraz mobilnego menu. Na potrzeby osobnego prototypu Next Link zastąpiono zwykłym linkiem, a klasy Tailwind odpowiadającym CSS.
- `src/app.tsx`, `src/style.css` — makiety i style.
- `CHECKS.json` — wyniki sprawdzenia przeglądarkowego i głównego flow.
- `SURFACE_BRIEF.md` — założenia projektu i użycia skilli.

Oryginalny prompt sidebara: `C:/Users/micha/.codex/attachments/a9fd80f1-ca84-49ba-8fc4-b4b121af324a/Wklejony tekst.txt`. Logo i font Hanken Grotesk pochodzą z istniejącego projektu. PNG są rzeczywistymi zrzutami przeglądarki.

## Ponowne uruchomienie

Z katalogu głównego repozytorium:

```powershell
node docs/design/goldis/mvp-2026-10-11/serve.cjs
```

W razie potrzeby przebudowania:

```powershell
npm install --prefix docs/design/goldis/mvp-2026-10-11/runtime --no-audit --no-fund
node docs/design/goldis/mvp-2026-10-11/build.cjs
node docs/design/goldis/mvp-2026-10-11/capture.cjs
node docs/design/goldis/mvp-2026-10-11/gallery.cjs
```

Prototyp jest odizolowany w tym katalogu; dostarcza projekt interfejsu i docelowego przepływu pracy. Nowe funkcje leadów wymagają osobnego wdrożenia w aplikacji.

