---
target: apps/web/app/workspace.tsx — logowanie i przejście do dashboardu
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\micha\\Desktop\\Goldis-Automatyzacje\\apps\\web\\app\\workspace.tsx"
target_fingerprint: "sha256:d2391a29693210e152034050839de1df073025d86b9c0f46d6221508f92a4faa"
target_path: "C:\\Users\\micha\\Desktop\\Goldis-Automatyzacje\\apps\\web\\app\\workspace.tsx"
timestamp: 2026-10-12T09-23-14Z
slug: apps-web-app-workspace-tsx
closed: true
---
Method: dual-agent (A: /root/design_assessment · B: /root/evidence_assessment)

## Zakres

W repozytorium nie ma osobnej strony marketingowej. Audyt obejmuje ekran logowania pod `/` oraz pierwszy widok po zalogowaniu pod `/dashboard` — czyli faktyczny pierwszy kontakt z aplikacją i drogę do rozpoczęcia weryfikacji OC.

## Ocena heurystyk Nielsena

| # | Heurystyka | Ocena | Główna obserwacja |
|---|---|---:|---|
| 1 | Widoczność stanu systemu | 2/4 | Formularz pokazuje „Logowanie…”, ale dashboard może chwilowo pokazać link „Otwórz wyniki”, zanim sprawdzi uprawnienia. |
| 2 | Dopasowanie do języka użytkownika | 2/4 | „Uruchom automatyzację” prowadzi do importu; stan workera widać dopiero w narzędziu. |
| 3 | Kontrola i swoboda | 3/4 | Nawigacja pozwala przejść do zadań i wyników, a logowanie po sukcesie kieruje do widoku zależnego od roli. |
| 4 | Spójność i standardy | 3/4 | Logo, ciemna paleta i typografia są spójne; główne działanie na dashboardzie pojawia się w dwóch miejscach. |
| 5 | Zapobieganie błędom | 3/4 | Pola mają etykiety, są wymagane i obsługują autouzupełnianie; brakuje ścieżki odzyskania dostępu. |
| 6 | Rozpoznawanie zamiast przypominania | 3/4 | Skróty i statusy są widoczne, choć częściowo powtarzają ten sam start. |
| 7 | Elastyczność i efektywność | 2/4 | Start nowego zadania jest dostępny od razu, ale ładowanie dashboardu może skierować do wyników. |
| 8 | Estetyka i minimalizm | 3/4 | Logowanie ma mocną identyfikację marki; mobilny kadr traci dużo miejsca u góry, a dashboard nierówno wypełnia kolumny. |
| 9 | Odzyskiwanie po błędzie | 2/4 | Błąd logowania jest czytelny, ale nie podpowiada dalszego kroku; błąd pobrania dashboardu może wyglądać jak brak danych. |
| 10 | Pomoc i dokumentacja | 1/4 | Na ekranie logowania nie ma widocznej pomocy ani kontaktu w sprawie dostępu. |
| **Razem** |  | **24/40 — akceptowalny** | Dobre podstawy, ale kilka problemów utrudnia pewne rozpoczęcie pracy. |

## Specyfika projektu i ogólne wrażenie

Ekran logowania wygląda jak Goldis: oryginalne logo, czerń ze złotem, szeryfowy nagłówek i lokalne fonty tworzą rozpoznawalny charakter. Dashboard jest bardziej typowym pulpitem operacyjnym — co pasuje do aplikacji wewnętrznej — ale może wyraźniej prowadzić do najważniejszego zadania pracownika: przygotowania nowej weryfikacji OC.

### Co działa

- Formularz logowania jest prosty i dobrze opisany; przy wysyłaniu przycisk zmienia stan, a błędy są ogłaszane.
- Po załadowaniu uprawnień pulpit ma widoczny skrót do narzędzia, listę spraw wymagających uwagi i historię operacji.

## Najważniejsze problemy i poprawki

1. **[P1] Link na dashboardzie może przez moment prowadzić do wyników zamiast do nowej weryfikacji.** Zanim `/api/dashboard` zwróci uprawnienia, CTA przyjmuje wariant „Otwórz wyniki”. Przy wolnym połączeniu użytkownik może kliknąć niewłaściwy adres. Jeśli pobieranie danych się nie powiedzie, puste wartości mogą wyglądać jak prawdziwe zera. **Poprawka:** do czasu odpowiedzi pokaż nieklikalny stan „Sprawdzam dostęp…” lub szkielet; po błędzie pokaż ponowienie i nie przedstawiaj brakujących danych jako pustego profilu. **Proponowane działanie:** `$impeccable harden`.

2. **[P1] CTA obiecuje uruchomienie, choć następnym krokiem jest import, a portal może być niedostępny.** „Uruchom automatyzację” prowadzi do przygotowania pliku. Stan workera portali jest pokazany dopiero na stronie narzędzia; osoba klikająca może oczekiwać natychmiastowego startu. **Poprawka:** nazwij ten krok „Przygotuj import OC” lub „Nowa weryfikacja OC” i pokaż dostępność usługi przed wyborem pliku. Słowo „Uruchom” zostaw na moment, w którym operacja faktycznie może ruszyć. **Proponowane działanie:** `$impeccable clarify`.

3. **[P2] Mobilny ekran logowania marnuje miejsce nad formularzem.** Zrzut mobilny pokazuje dużą pustą strefę nad nagłówkiem, przez co formularz zaczyna się nisko. Reguła mobilna nadal rezerwuje 204 px na logo. To obserwacja ze zrzutu projektu; bieżącego widoku mobilnego nie sprawdzono na żywo. **Poprawka:** zmniejsz tę strefę i logo, sprawdź jego kadr na telefonie oraz przysuń kartę logowania do nagłówka. **Proponowane działanie:** `$impeccable adapt`.

4. **[P2] Dashboard powtarza start OC i na telefonie zamienia skróty w długi ciąg kart.** Główne CTA i pierwszy skrót prowadzą do tego samego miejsca. Pięć kart skrótów zajmuje dużo pionowej przestrzeni, a na desktopie panel skrótów jest znacznie wyższy niż „Do zrobienia”. **Poprawka:** zostaw jeden dominujący przycisk „Nowa weryfikacja OC”; skróć listę skrótów albo wykorzystaj wolną kolumnę na ostatnie operacje. **Proponowane działanie:** `$impeccable layout`.

5. **[P2] Użytkownik z błędem logowania nie wie, jak odzyskać dostęp.** Komunikat „Sprawdź login i hasło” jest czytelny, ale nie ma linku do pomocy ani informacji, do kogo zwrócić się przy zapomnianym haśle. **Poprawka:** dodaj krótką wskazówkę do rzeczywistego procesu odzyskiwania dostępu lub kontaktu z administratorem. **Proponowane działanie:** `$impeccable clarify`.

## Ścieżki użytkowników

- **Jordan, nowa osoba:** rozpozna formularz i pola, ale przy problemie z hasłem nie dostaje dalszej wskazówki. Po zalogowaniu etykieta „Uruchom automatyzację” nie zdradza, że najpierw trzeba przygotować import.
- **Riley, osoba sprawdzająca błędy:** podczas wolnego ładowania może trafić do wyników zamiast do nowego zadania. Po błędzie API brakujące dane mogą wyglądać na zera; brakuje widocznej akcji ponowienia.
- **Casey, osoba korzystająca z telefonu:** górna pusta strefa logowania i pięć pionowo ułożonych skrótów na pulpicie wydłużają dojście do pracy. Na plus: pola autouzupełniają się, a przycisk ma wysokość 46 px, pola na telefonie co najmniej 44 px.

**Obciążenie poznawcze:** umiarkowane; 2 z 8 punktów checklisty nie przechodzą. Skróty i sekcje są czytelne, ale pierwsze działanie jest powtórzone, a na pulpicie widać wiele dróg na raz.

## Skan i materiał wizualny

Detektor Impeccable dla `app/page.tsx` i `app/workspace.tsx` zwrócił **0 ostrzeżeń i 0 uwag**. To skan struktury; nie wykrył zachowania CTA przy pierwszym renderze, które wynika z logiki ładowania danych.

Lokalny widok desktopowy `/` otworzył ekran logowania. Pola i etykiety były obecne w drzewie dostępności. Widok mobilny nie był dostępny na żywo; obserwację mobilną opieram na zrzucie projektu z 12 października. Nakładek Impeccable nie udało się pokazać w przeglądarce, więc nie ma widocznej warstwy z wykrytymi problemami.

Drobna uwaga dostępnościowa: tekst „Ładowanie panelu…” jest widoczny, ale nie ma roli `status`, więc warto sprawdzić, czy zmiana stanu jest dobrze ogłaszana czytnikom ekranu.

## Pytania do przemyślenia

- Czy główny przycisk powinien prowadzić do „Nowej weryfikacji OC” i nazywać aktualny krok, zamiast obiecywać pełne uruchomienie?
- Czy pięć skrótów jest potrzebnych na pierwszym ekranie, skoro główny start OC już jest obok nagłówka?
- Jaką informację o dostępności portalu użytkownik powinien zobaczyć, zanim wybierze plik i zacznie przygotowywać import?
