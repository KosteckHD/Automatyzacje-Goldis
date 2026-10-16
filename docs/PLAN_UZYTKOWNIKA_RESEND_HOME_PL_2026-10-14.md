# Plan użytkownika — domena w home.pl i wysyłka odzyskiwania hasła przez Resend

Data: 14 października 2026. Status: **instrukcja do wykonania**. Wskazany operator: **home.pl**. Nazwa domeny nie została jeszcze podana. Przykładowe `example.com` należy wszędzie zastąpić własną domeną. Plan kodu agenta: [implementacja odzyskiwania hasła](PLAN_IMPLEMENTACJI_ODZYSKIWANIA_HASLA_RESEND_2026-10-14.md).

## Wybrany układ

| Zastosowanie | Przykład |
| --- | --- |
| Istniejąca domena firmy | `example.com` |
| Aplikacja na VPS | `https://app.example.com` |
| Domena wysyłkowa Resend | `system.example.com` |
| Nadawca wiadomości | `Goldis <powiadomienia@system.example.com>` |
| Odpowiedzi użytkowników | Istniejąca skrzynka `pomoc@example.com`, jako Reply-To |
| Adres odzyskiwania | Własna skrzynka każdej osoby, np. `jan@example.com` |

DNS autoryzuje domenę wysyłkową. Goldis komunikuje się z Resend przez HTTPS API. Nie instalujesz serwera SMTP na VPS i nie przekazujesz aplikacji hasła do swojej skrzynki firmowej.

## U01. Ustal nazwy i zbierz dane

- [ ] Wybrać rzeczywistą domenę firmy, subdomenę aplikacji i subdomenę wysyłkową.
- [ ] Wybrać istniejącą skrzynkę Reply-To i własną indywidualną skrzynkę odzyskiwania konta admina.
- [ ] Przygotować listę loginów i indywidualnych adresów pracowników — bez haseł.
- [ ] Potwierdzić, kto ma prawa do DNS i konta Resend.

**Gotowe, gdy:** wiadomo, jak będą wyglądały wszystkie adresy. Wspólna skrzynka odzyskiwania wszystkich użytkowników dawałaby jej właścicielom dostęp do wielu kont.

## U02. Sprawdź, gdzie jest aktywna strefa DNS

Rejestracja domeny w home.pl nie musi oznaczać, że home.pl obsługuje jej DNS. Sprawdź delegację/NS domeny. Jeżeli aktywne DNS są u innego operatora, rekordy trzeba dodawać tam. Nie zmieniaj delegacji całej domeny tylko dla tej integracji. [home.pl o zarządzaniu strefą DNS](https://pomoc.home.pl/baza-wiedzy/how-do-i-create-or-edit-domain-records).

- [ ] Sprawdzić NS i aktywnego operatora strefy.
- [ ] Zachować zapis obecnych rekordów, zwłaszcza MX domeny głównej, SPF i DMARC, oraz A/AAAA strony.
- [ ] Potwierdzić, że wybrana subdomena `system` nie obsługuje już innej usługi.

**Gotowe, gdy:** edytujesz rzeczywiście aktywną strefę i masz możliwość odtworzenia dodawanych/zmienianych wpisów.

## U03. Dodaj domenę wysyłkową w Resend

W panelu Resend wybierz Domains, dodaj `system.<twoja-domena>` i wybierz odpowiedni region wysyłki. Na pierwsze wdrożenie użyj domyślnego Return-Path. Zanotuj rekordy wygenerowane dla tej domeny; Resend może pokazać TXT/MX albo CNAME, zależnie od konfiguracji. [Resend: dodanie domeny](https://resend.com/docs/add-a-domain).

- [ ] Domena/subdomena wpisana bez `https://` i bez adresu `powiadomienia@`.
- [ ] Zachowana lista: typ, pełna nazwa, wartość, priorytet MX, TTL.
- [ ] Weryfikujemy domenę wysyłkową, nie przekierowujemy na Resend całej firmowej poczty.

## U04. Otwórz edycję DNS w home.pl

W panelu klienta: **Domeny → wybrana domena → Hosting DNS → Opcje → Zarządzaj rekordami DNS → Dodaj nowy rekord**. Wybierz typ, wpisz Host i wartość. TTL możesz pozostawić domyślny; MX wymaga również priorytetu. Host pusty dotyczy domeny głównej. [Instrukcja home.pl](https://pomoc.home.pl/baza-wiedzy/rekord-dla-domeny-jak-dodac-usunac-lub-zmienic-rekord-dla-subdomeny).

Przykład: jeżeli edytujesz strefę `example.com`, a docelowy rekord to `send.system.example.com`, część względna wynosi `send.system`. Po zapisaniu sprawdź pełną nazwę w liście/publicznym DNS. Nie doprowadź do nazwy `send.system.example.com.example.com`. Jeśli wybrałeś odrębną strefę subdomeny, względna nazwa będzie inna — kieruj się pełną nazwą docelową.

## U05. Dodaj rekordy wysyłkowe z panelu Resend

Poniższa tabela pokazuje **rodzaje wpisów i przykład nazw**. Nie jest zestawem gotowych wartości do wklejenia. Selektory DKIM, host Return-Path, wartości TXT/CNAME, cel i priorytet MX muszą odpowiadać Twojemu panelowi Resend.

| Cel | Typ | Przykładowa pełna nazwa | Host przy strefie `example.com` | Wartość |
| --- | --- | --- | --- | --- |
| Podpis DKIM | TXT lub CNAME wskazany przez Resend | `<selektor>._domainkey.system.example.com` | `<selektor>._domainkey.system` | Dokładny klucz TXT lub cel CNAME z Resend |
| Uprawnienie SPF | TXT, jeśli taki wpis podaje Resend | `send.system.example.com` | `send.system` | Dokładna wartość SPF z Resend |
| Return-Path / obsługa zwrotów | MX, jeśli taki wpis podaje Resend | `send.system.example.com` | `send.system` | Dokładny host pocztowy i priorytet z Resend |
| Polityka DMARC nadawcy | TXT | `_dmarc.system.example.com` | `_dmarc.system` | Projekt polityki z U06 |

Źródłem rzeczywistych rekordów jest zakładka Records domeny w Resend. [Wymagania weryfikacji](https://resend.com/docs/add-a-domain).

- [ ] Wprowadzić wszystkie wpisy DKIM pokazane w panelu — może być więcej niż jeden.
- [ ] Dodać SPF i MX wyłącznie na wskazanych nazwach Return-Path, jeśli panel ich wymaga.
- [ ] Nie wpisywać do DNS klucza API `re_...`; TXT DKIM zawiera materiał publiczny wygenerowany do DNS.
- [ ] Nie dodawać drugiego SPF `v=spf1` na tej samej nazwie. Istniejący konflikt trzeba rozstrzygnąć; różne nazwy DNS mogą mieć własne SPF. [RFC 7208, §3.2](https://www.rfc-editor.org/rfc/rfc7208.html#section-3.2).
- [ ] Nie dodawać równolegle TXT i CNAME pod tą samą nazwą DKIM; użyć wariantu wymaganego przez dostawcę.
- [ ] Sprawdzić, że nie ruszono MX dla `example.com` i nie zmieniono poczty pracowników.

**Gotowe, gdy:** pełne nazwy i wartości w publicznym DNS zgadzają się z panelem Resend. Dokładnych kluczy DKIM i regionalnego celu MX nie da się wyznaczyć przed utworzeniem domeny w Twoim koncie.

## U06. Dodaj lub sprawdź DMARC dla subdomeny

Najpierw sprawdź istniejący `_dmarc.<domena-główna>` i `_dmarc.system.<domena>`. Przy braku własnego rekordu subdomena może dziedziczyć politykę domeny nadrzędnej; nie zakładaj automatycznie, że nie ma żadnej ochrony. [RFC 7489: wybór polityki](https://www.rfc-editor.org/rfc/rfc7489.html#section-6.6.3).

Jeżeli firma nie ma już ustalonej polityki obejmującej tę subdomenę, propozycja etapu testowego to jeden TXT dla `_dmarc.system`:

```text
v=DMARC1; p=none;
```

Po uruchomieniu realnej skrzynki raportowej w tej samej domenie organizacyjnej można dodać:

```text
v=DMARC1; p=none; rua=mailto:dmarc@example.com;
```

To przykłady: rzeczywistą skrzynkę trzeba wcześniej utworzyć. `p=none` służy obserwacji i nie każe odrzucać podszywających się wiadomości. Po odbiorze zgodnych wiadomości zaostrzyć politykę do `quarantine`, następnie `reject`, zgodnie z polityką firmy. Nie zastępować istniejącej silniejszej polityki słabszą bez uzgodnienia. Nie dodawać dwóch rekordów DMARC dla tego samego hosta. [Resend: DMARC](https://resend.com/docs/dashboard/domains/dmarc).

**Gotowe, gdy:** rozumiesz, jaką politykę ma subdomena; testy pokazują `dmarc=pass`, a finalna polityka została świadomie wybrana.

## U07. Zweryfikuj domenę w Resend

- [ ] Uruchomić weryfikację domeny w panelu.
- [ ] Poczekać na propagację i status Verified dla wysyłki.
- [ ] Gdy wpis nie jest widoczny, porównać jego pełną nazwę, typ, wartość i aktywne NS. Nie zmieniać na próbę MX domeny głównej.
- [ ] Zanotować status i konfigurację domeny do odbioru z agentem.

Przykładowe polecenia w PowerShell, po zastąpieniu domeny i selektora prawdziwymi wartościami:

```powershell
Resolve-DnsName -Name example.com -Type NS
Resolve-DnsName -Name send.system.example.com -Type TXT
Resolve-DnsName -Name send.system.example.com -Type MX
Resolve-DnsName -Name "<selektor>._domainkey.system.example.com" -Type TXT
Resolve-DnsName -Name _dmarc.system.example.com -Type TXT
```

Dla DKIM w wariancie CNAME użyj `-Type CNAME`. Polecenia z `<selektor>` są wzorami do uzupełnienia, nie gotowym skryptem. Home/Resend mogą wskazać inne nazwy niż przykładowe `send.system`; wtedy sprawdzasz właśnie je. Sam poprawny DNS nie potwierdza jeszcze dostarczenia wiadomości.

## U08. Ustaw nadawcę i wyłącz tracking

- [ ] Wybrać From: `Goldis <powiadomienia@system.<twoja-domena>>`.
- [ ] Ustawić Reply-To na istniejącą skrzynkę wsparcia firmy.
- [ ] Wyłączyć open tracking i click tracking dla domeny wiadomości resetu/weryfikacji. Link ma prowadzić bezpośrednio do Goldis.
- [ ] Nie uruchamiać inbound/Receiving w Resend na potrzeby samego resetu. Firma nadal odbiera zwykłą pocztę u dotychczasowego dostawcy; Reply-To może kierować do tej skrzynki.

Wysyłka ze zweryfikowanej domeny nie wymaga osobnej skrzynki odbiorczej dla każdego adresu From. W tym projekcie nadawca jest techniczny, a odpowiedzi kierujemy do istniejącej skrzynki. [Resend Verified Domains](https://resend.com/docs/dashboard/domains/introduction).

## U09. Utwórz i osadź klucz API

W Resend wybierz API Keys i utwórz klucz `Goldis-production-mail` z **Sending access**, ograniczonym do wybranej domeny. Zapisz go w bezpiecznym miejscu; nie wybieraj pełnego dostępu, jeśli aplikacja tylko wysyła maile. [Resend API keys](https://resend.com/docs/create-an-api-key).

- [ ] Osadzić klucz na VPS w pliku sekretu przygotowanym w konfiguracji wdrożenia, odczytywanym przez API jako `RESEND_API_KEY_FILE`.
- [ ] Nie wklejać klucza do DNS, dokumentów planu, repozytorium, frontendowych zmiennych `NEXT_PUBLIC_*` ani logów. Do uzgadniania wystarcza informacja, że sekret jest gotowy.
- [ ] Osobny klucz testowy, jeśli będzie używane oddzielne środowisko testowe.
- [ ] Ustalić właściciela konta Resend i sposób odwołania/rotacji klucza; zabezpieczyć konto administracyjne dostawcy.

Nie potrzebujemy hasła do skrzynki home.pl. Klucz Resend nie jest kluczem szyfrowania kolejki; ten drugi wygeneruje agent w konfiguracji aplikacji.

## U10. Skieruj aplikację na VPS i odbierz HTTPS

Jeżeli aplikacja nie ma jeszcze domeny, w aktywnej strefie dodaj:

| Typ | Host przy strefie `example.com` | Wartość |
| --- | --- | --- |
| A | `app` | Rzeczywisty publiczny IPv4 VPS |
| AAAA — tylko przy działającym IPv6 | `app` | Rzeczywisty IPv6 VPS z odebraną obsługą ruchu i TLS |

Jeżeli `app` już obsługuje aplikację, sprawdź istniejący wpis zamiast dodawać konkurencyjne adresy. Ten krok dotyczy strony WWW, a nie autoryzacji wysyłki. Zmiana A dla `app` nie wymaga zmiany A/MX całej domeny firmy.

- [ ] Nginx i certyfikat HTTPS obsługują rzeczywiste `app.<domena>`.
- [ ] `PUBLIC_APP_ORIGIN` w Goldis jest identyczny z tym adresem, bez ścieżki; linki nie prowadzą do localhost lub IP.
- [ ] API i DB nie mają publicznych portów; ruch do aplikacji przechodzi przez ustaloną bramę.
- [ ] Agent odbiera origin/cookies/proxy razem z konfiguracją aplikacji. Sam wpis DNS nie instaluje certyfikatu.

## U11. Przekaż agentowi komplet konfiguracji

Do uzupełnienia — bez sekretów:

```text
Domena główna:
Operator aktywnego DNS: home.pl / inny:
Adres aplikacji HTTPS:
Zweryfikowana domena Resend:
From:
Reply-To:
Region Resend:
Status Verified:
Tracking otwarć: wyłączony
Tracking kliknięć: wyłączony
Klucz API osadzony w sekrecie VPS: tak/nie
Adres testowego konta:
Adres konta administratora:
```

Osobno można przekazać listę publicznych rekordów Resend (typ/nazwa/wartość/priorytet), aby sprawdzić ich zapis w home.pl. Nie przekazuj tu klucza API.

## U12. Odbierz prawdziwą wysyłkę i odzyskiwanie

- [ ] Odebrać link weryfikacji na syntetycznym koncie i potwierdzić adres.
- [ ] Zlecić reset, odebrać wiadomość; sprawdzić From, Reply-To, domenę linku i czas ważności.
- [ ] Sprawdzić nagłówki wiadomości: SPF/DKIM oraz DMARC pass i zgodność z domeną nadawcy. Status Accepted/Submitted w Resend nie oznacza jeszcze wiadomości w skrzynce.
- [ ] Ustawić nowe hasło, zalogować się nim, potwierdzić niedziałanie starego hasła i starej sesji.
- [ ] Otworzyć ten sam link ponownie — powinien zostać odrzucony.
- [ ] Sprawdzić również wygasły link i przycisk „Wyślij link” w administracji.
- [ ] Odebrać powiadomienie o zmianie hasła.
- [ ] Sprawdzić odbiór u faktycznych dostawców poczty pracowników i w folderze spam, a także zwykłą firmową pocztę home.pl po zmianach DNS.

Agent wykonuje testy kodu i bezpieczeństwa, właściciel potwierdza realną skrzynkę/domenę. Pierwszy test nie wykorzystuje danych klientów ani ich adresów.

## U13. Włącz dla pracowników i ustal obsługę

- [ ] Każdy użytkownik ma indywidualny zweryfikowany adres. Konta bez adresu zachowują dotychczasowe logowanie, ale nie mają samodzielnego odzyskiwania do czasu przypisania.
- [ ] Ustalić kontakt, jeśli osoba utraciła także skrzynkę pocztową. Nie przypisywać nowego adresu na podstawie niezweryfikowanego zgłoszenia.
- [ ] Kontrolować limity/rozliczenia Resend i błędy wysyłki; dane z wiadomości są ograniczone do obsługi kont.
- [ ] Po odbiorze SPF/DKIM/DMARC ustalić docelową silną politykę DMARC według U06.
- [ ] Zachować listę własnych dodanych rekordów i instrukcję odwołania klucza. Rollback integracji nie polega na kasowaniu całej strefy DNS ani zmienianiu MX poczty firmowej.

## Co dokładnie zmieniasz w DNS

Domyślnie **dodajesz** rekordy wskazane przez Resend dla subdomeny wysyłkowej i jej Return-Path, własny DMARC według istniejącej polityki oraz ewentualnie A dla subdomeny aplikacji. Istniejący rekord pod tą samą nazwą wymaga sprawdzenia konfliktu przed edycją. Główne MX, SPF, NS i strona firmy nie wymagają zmiany przy proponowanej topologii.

Nazwy i wartości końcowe ustalimy po podaniu rzeczywistej domeny i wygenerowaniu listy rekordów w Resend. Ten dokument pozwala przygotować usługę bez zgadywania klucza DKIM lub celu MX.
