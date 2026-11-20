"""Compatibility engine ported from the private v7 prototype."""
from __future__ import annotations
import argparse, collections, datetime as dt, hashlib, json, re, unicodedata, warnings
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent
warnings.filterwarnings('ignore', category=UserWarning, module='openpyxl')

def clean(value):
    if value is None: return ''
    if isinstance(value, float) and value.is_integer(): return str(int(value))
    return str(value).strip()

def norm(value):
    text = unicodedata.normalize('NFKD', clean(value).replace('ł','l').replace('Ł','L'))
    return ' '.join(''.join(c for c in text if not unicodedata.combining(c)).upper().split())

def number(value):
    return re.sub(r'\s+', '', clean(value)).upper()

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def load_book(path):
    book = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_vba=False)
    formula_book = openpyxl.load_workbook(path, read_only=True, data_only=False, keep_vba=False)
    result = {}
    total_rows = 0
    total_cells = 0
    for sheet in book:
        if len(result) >= 40:
            book.close()
            formula_book.close()
            raise ValueError('WORKBOOK_LIMITS_EXCEEDED: zbyt wiele arkuszy.')
        sheet.reset_dimensions()  # Raporty Warty deklarują błędny wymiar A1.
        formula_sheet = formula_book[sheet.title]
        formula_sheet.reset_dimensions()
        rows = []
        value_rows = sheet.iter_rows(values_only=True)
        formula_rows = formula_sheet.iter_rows()
        for row, formula_row in zip(value_rows, formula_rows):
            total_rows += 1
            total_cells += len(row)
            if total_rows > 250_000 or total_cells > 1_500_000:
                book.close()
                formula_book.close()
                raise ValueError('WORKBOOK_LIMITS_EXCEEDED: przekroczono limit wierszy lub komórek.')
            rows.append(tuple(None if isinstance(cell.value, str) and cell.value.startswith('=') else value
                              for value, cell in zip(row, formula_row)))
        result[sheet.title] = rows
    book.close()
    formula_book.close()
    return result

def reject_critical_formulas(path, columns):
    """Do not trust cached formula results because no spreadsheet engine recalculates them."""
    book = openpyxl.load_workbook(path, read_only=True, data_only=False, keep_vba=False)
    try:
        row_count = 0
        for sheet in book:
            sheet.reset_dimensions()
            for row_index, row in enumerate(sheet.iter_rows(), 1):
                row_count += 1
                if row_count > 250_000:
                    raise ValueError('WORKBOOK_LIMITS_EXCEEDED: przekroczono limit wierszy.')
                for column_index, cell in enumerate(row, 1):
                    if column_index in columns and isinstance(cell.value, str) and cell.value.startswith('='):
                        coordinate = getattr(cell, 'coordinate', None)
                        if coordinate is None:
                            from openpyxl.utils import get_column_letter
                            coordinate = f'{get_column_letter(column_index)}{row_index}'
                        raise ValueError(f'FORMULA_REQUIRES_VALUE:{sheet.title}!{coordinate}')
    finally:
        book.close()

def brand(value, profile='', policy_number=''):
    v, p = norm(value), norm(profile)
    if v=='DA DIREKT' and re.fullmatch(r'OMPLINS\d+',number(policy_number)):
        return 'OMINIMO'
    if p == 'WIENER': return 'WIENER'
    if p == 'PROAMA': return 'PROAMA'
    if p in ['JUPITER (MTU)', 'YCD']: return 'MTU'
    aliases = [('WARTA ZYCIE','WARTA ŻYCIE'), ('PZU ZYCIE','PZU ŻYCIE'),
        ('UNIQA ZYCIE','UNIQA ŻYCIE'),('COMPENSA ZYCIE','COMPENSA ŻYCIE'),('ALLIANZ ZYCIE','ALLIANZ ŻYCIE'),
        ('UNIQA','UNIQA'), ('ALLIANZ','ALLIANZ'), ('AGRO','AGRO'),
        ('COMPENSA','COMPENSA'), ('ERGO HESTIA','ERGO HESTIA'),
        ('EUROINS','EUROINS'), ('GENERALI','GENERALI'), ('INTERRISK','INTERRISK'),
        ('LINK4','LINK4'), ('MTU','MTU'), ('OMINIMO','OMINIMO'), ('PROAMA','PROAMA'),
        ('PZU','PZU'), ('TUW TUW','TUW TUW'), ('TUZ','TUZ'), ('WARTA','WARTA'), ('WIENER','WIENER')]
    for needle, result in aliases:
        if needle in v: return result
    return v

def agent(value):
    v = norm(value)
    if 'CYBULSKA' in v and 'ALEKSANDRA' in v: return 'Ola'
    if 'BACZKOWSKI' in v and 'MACIEJ' in v: return 'Maciek'
    return clean(value) or 'Nieustalony'

def rate_decimal(value):
    if value is None or clean(value) == '': return None
    try: return Decimal(clean(value).replace(',', '.').replace('%',''))
    except Exception: return None

def rate_status(actual, expected, tolerance=Decimal('0.000001')):
    a, e = rate_decimal(actual), rate_decimal(expected)
    if a is None or e is None: return 'BRAK_DANYCH'
    return 'ZGODNA' if abs(a-e) <= tolerance else 'BLEDNY_PROCENT'

def normalized_number(insurer, policy):
    n = number(policy)
    if insurer=='ALLIANZ':
        return n.rsplit('-',1)[-1] if '-' in n else n
    patterns = {'PZU':r'^(\d{10})-\d+$', 'COMPENSA':r'^\d{5}-(\d+)$',
        'EUROINS':r'^(\d{12})/\d+$', 'UNIQA':r'^20\d{2}-(\d+)$',
        'AGRO':r'^\d+N(\d+)$','OMINIMO':r'^OMPLINS(\d+)$',
        'TUW TUW':r'^(?:11|14|33)(\d{8})$', 'WARTA':r'^(\d{12})W\d+$'}
    m = re.match(patterns.get(insurer, r'(?!)'), n)
    return m.group(1) if m else n

def alternative_keys(insurer, policy):
    keys={number(policy),normalized_number(insurer,policy)}
    # Dawna hipoteza bez myślnika pozostaje wyłącznie kandydatem do wyjaśnienia.
    if insurer=='ALLIANZ' and re.fullmatch(r'260\d{8}',number(policy)):
        keys.add(number(policy)[3:])
    return keys

def classify_match(policy, exact, alternatives, by_number, confirmed_formats):
    key = (policy['insurer'], number(policy['number']))
    exact_rows=exact.get(key,[])
    if exact_rows and key[0] not in confirmed_formats: return 'DOKLADNE', exact_rows, ''
    candidates = {}
    for alt in alternative_keys(*key):
        for row in alternatives.get((key[0], alt), []): candidates[row['id']] = row
    if candidates:
        if key[0] in confirmed_formats:
            # Kilka różnych numerów po normalizacji może oznaczać kilka odnowień.
            raw = {number(r['number']) for r in candidates.values()}
            core=normalized_number(*key)
            # Pełny numer i jego skrót łączymy; kilku różnych sufiksów odnowienia nie.
            if len(raw-{core})<=1 and all(normalized_number(key[0],r['number'])==core for r in candidates.values()):
                if exact_rows and len(exact_rows)==len(candidates):return 'DOKLADNE',exact_rows,''
                return 'FORMAT_PRZYJETY', list(candidates.values()), 'Dopasowanie według przyjętej roboczo reguły formatu numeru.'
        return 'DO_POTWIERDZENIA', list(candidates.values()), 'Podobny numer; różnica formatu nie została potwierdzona lub pasuje kilka numerów.'
    other = by_number.get(key[1], [])
    if other:
        return 'DO_POTWIERDZENIA', other, 'Ten sam numer, ale różne oznaczenia towarzystwa lub marki.'
    return 'BRAK', [], 'Nie znaleziono numeru ani zdefiniowanego wariantu w dostarczonych raportach.'

def reverse_audit(crm, records, confirmed, begin, end):
    """Compare every report against ALL supplied CRM dates, keeping date scope explicit."""
    exact=collections.defaultdict(list);alts=collections.defaultdict(list);bynum=collections.defaultdict(list)
    for p in crm:
        exact[p['insurer'],number(p['number'])].append(p);bynum[number(p['number'])].append(p)
        for n in alternative_keys(p['insurer'],p['number']):alts[p['insurer'],n].append(p)
    groups={};counts=collections.Counter()
    for r in records:
        state,matches,why=classify_match(r,exact,alts,bynum,confirmed)
        counts[state]+=1
        if state in ['DOKLADNE','FORMAT_PRZYJETY']:continue
        key=(r['insurer'],r['source_type'],normalized_number(r['insurer'],r['number']),state)
        g=groups.setdefault(key,{'insurer':r['insurer'],'source_type':r['source_type'],
            'number':key[2],'kind':'BRAK_W_CRM' if state=='BRAK' else 'NIEPEWNY_CRM',
            'numbers':set(),'agents':set(),'dates':set(),'refs':[],'crm_candidates':set(),'rows':0})
        g['numbers'].add(r['number']);g['agents'].add(r['agent']);g['rows']+=1
        if r['contract_date']:g['dates'].add(r['contract_date'])
        g['refs'].append({'file':r['file'],'sheet':r['sheet'],'row':r['row']})
        g['crm_candidates'].update(p['number'] for p in matches)
    output=[]
    for g in groups.values():
        for field in ['numbers','agents','dates','crm_candidates']:g[field]=sorted(g[field])
        in_period=[v for v in g['dates'] if begin.isoformat()<=v<=end.isoformat()]
        g['date_scope']='Data umowy ASF w okresie' if in_period else 'Data umowy ASF poza okresem' if g['dates'] else 'Brak daty wystawienia / umowy'
        g['direction']='Brak w CRM' if g['kind']=='BRAK_W_CRM' else 'Niepewne dopasowanie do CRM'
        output.append(g)
    return {'crm_policies_all_dates':len(crm),'report_record_status_counts':dict(counts),
        'rows':sorted(output,key=lambda g:(g['insurer'],g['kind'],g['source_type'],g['number'])),
        'note':f'Sprawdzono cały dostarczony CRM, również poza okresem {begin.isoformat()}–{end.isoformat()}. Data umowy ASF nie jest datą wystawienia CRM; Warta nie podaje daty wystawienia. Grupy: TU, źródło i numer po normalizacji.'}

def create_preset(base):
    source = base/'TABELA PROWIZJI'/'PROPOZYCJA PROWIZJI.xlsx'
    book = openpyxl.load_workbook(source, read_only=True, data_only=True)
    rules = {}
    def add(key, sheet, cell, label):
        c = book[sheet][cell]; raw = c.value
        if isinstance(raw, (int,float)):
            val = Decimal(str(raw)) * (100 if '%' in c.number_format else 1)
        else:
            m = re.search(r'(\d+(?:[,.]\d+)?)\s*%', clean(raw))
            if not m: raise ValueError(f'Brak procentu: {sheet}!{cell}')
            val = Decimal(m.group(1).replace(',','.'))
        rules[key] = {'rate':float(val), 'label':label, 'source':str(source), 'sheet':sheet,
            'cell':cell, 'source_value':clean(raw), 'owner':'Ola' if sheet.endswith('OLA') else 'Ogólna'}
    specs = {
      'PZU; PZU ŻYCIE': [('PZU_OC_NEW','B3','OC nowe'),('PZU_OC_RENEW','C3','OC wznowienie'),('PZU_AC_NEW','B4','AC nowe'),('PZU_AC_RENEW','C4','AC wznowienie'),('PZU_HOME_NEW','B6','HOME nowe'),('PZU_HOME_RENEW','C6','HOME wznowienie'),('PZU_SME_NEW','B7','Doradca nowe'),('PZU_SME_RENEW','C7','Doradca wznowienie')],
      'GENERALI, GENERALI ŻYCIE':[('GEN_OC','B3','OC Solo'),('GEN_NNW_MO','B4','NNW komunikacyjne'),('GEN_ASS','B5','Assistance'),('GEN_AC','B6','AC'),('GEN_HOME','B8','HOME'),('GEN_TRAVEL','B9','Travel'),('GEN_NNW_GROUP','B10','NNW grupowe'),('GEN_NNW_IND','B11','NNW indywidualne')],
      'WARTA, WARTA ŻYCIE':[('W_OC','B3','OC'),('W_OC_ZP1','B4','OC ZP1'),('W_AC','B5','AC'),('W_SME','B6','SME'),('W_HOME','B7','DOM'),('W_HOME_PLUS','B8','DOM KOMFORT'),('W_FARM','B9','Rolne'),('W_TRAVEL','B10','Travel')],
      'WARTA OLA':[('OLA_W_OC','A5','OC indywidualne'),('OLA_W_OC_ZP1','A6','OC ZP1'),('OLA_W_AC','A4','AC'),('OLA_W_ASS','A7','Assistance'),('OLA_W_NNW','A8','NNW komunikacyjne'),('OLA_W_HOME','A32','DOM'),('OLA_W_HOME_PLUS','A33','DOM KOMFORT')],
      'UNIQA, UNIQA ŻYCIE':[('U_OC','B3','OC panel'),('U_AC','B4','AC panel'),('U_RIDERS','B5','Riders panel'),('U_SCHOOL','B7','NNW szkolne'),('U_HOME','B8','Mieszkania domy MSP'),('U_FARM_TRAVEL','B9','Rolne turystyczne')],
      'UNIQA OLA':[('OLA_U_OC','A4','OC panel'),('OLA_U_AC','A5','AC panel'),('OLA_U_RIDERS','A6','Riders panel'),('OLA_U_HOME','A21','Dom'),('OLA_U_SCHOOL','A29','Szkolne')],
      'ERGO HESTIA-iPegaz,iHestia':[('H_OC','B3','OC'),('H_AC_RIDERS','B4','AC i ridersy'),('H_TRAVEL','B5','Podróż'),('H_HOME','B6','Majątek'),('H_SME','B7','SME')],
      'ALLIANZ; ALLIANZ ŻYCIE':[('A_OC','B3','OC'),('A_OC_RIDERS','B4','OC+riders'),('A_AC','B5','AC'),('A_PACKAGE','B6','OC+AC'),('A_NNW','B7','NNW'),('A_HOME','B8','HOME'),('A_SME','B9','SME')],
      'COMPENSA; COMPENSA ŻYCIE':[('C_SME','B3','Firmowe'),('C_OC','B4','OC indywidualne'),('C_AC','B5','AC indywidualne'),('C_RIDERS','B6','NNW ASS komunikacyjne'),('C_HOME','B7','Dom'),('C_NNW','B8','NNW'),('C_TRAVEL','B9','Voyage')],
      'WIENER':[('WI_OC','B3','OC'),('WI_AC','B4','AC'),('WI_RIDERS','B5','Riders'),('WI_SME','B6','GoBiznes'),('WI_HOME','B7','Mieszkania')],
      'INTERRISK':[('I_OC','B3','OC'),('I_AC','B4','AC')],
      'LINK4':[('L_OC','B3','OC'),('L_RIDERS','B5','OC+riders'),('L_PACKAGE','B6','OC+AC'),('L_HOME','B7','Majątek')],
      'EUROINS':[('E_MOTOR','B3','Komunikacja')],
      'TUW TUW':[('TW_OC','B3','OC'),('TW_AC','B4','AC'),('TW_NNW','B5','NNW'),('TW_HOME','B8','Home')],
      'TUZ':[('TZ_OC','B3','OC'),('TZ_AC','B5','AC'),('TZ_RIDERS','B6','Riders'),('TZ_HOME','B7','Dom')],
      'MTU-JUPITER':[('MTU_ASS','B8','Assistance szyby'),('MTU_NNW','B9','NNW'),('MTU_RENEW_OC','G4','OC wznowienie')],
      'PROAMA':[('PR_OC_LOW','B4','OC niski próg'),('PR_OC_HIGH','C4','OC wysoki próg')],
    }
    for sheet, entries in specs.items():
        for key, cell, label in entries: add(key,sheet,cell,label)
    book.close()
    return {'version':'v1','description':'Eksperymentalne reguły odczytane z aktualnych tabel. Bez ustalonej historii stawek.',
        'source_sha256':digest(source),'created_at':dt.datetime.now(dt.timezone.utc).isoformat(),
        'confirmed_formats':[], 'rules':rules}

def select_rule(row, policy, policy_rows):
    """Wybór bez używania otrzymanego procentu jako wskazówki dla stawki oczekiwanej."""
    tu = row['insurer']; code = norm(row['risk_code']); risk = norm(row['risk_name'])
    profile = norm(row['profile']); group = norm(row['group']); typ = norm(row['type'])
    ola = row['agent'] == 'Ola'
    if row['source_type'] == 'WARTA': return None, 'Warta bez procentu i rozbicia na ryzyka.'
    if row['agent'] not in ['Ola','Maciek']: return None, 'Agent spoza ustalonej pary; brak przypisanej tabeli.'
    if rate_decimal(row['inkaso']) is not None and rate_decimal(row['inkaso']) <= 0: return None, 'Zwrot/korekta lub zerowe inkaso: osobna interpretacja rozliczenia.'
    if 'KOREKT' in norm(row['note']) or 'ZWROT' in typ: return None, 'Korekta lub zwrot: do osobnego wyjaśnienia.'
    motor='KOMUNIKACYJNE' in norm(policy.get('product_group',''))
    if tu=='AGRO':
        if not motor:return None,'Kod AGRO wymaga potwierdzenia komunikacyjnego rodzaju polisy w CRM.'
        if code=='BP5/OC':return 'AG_OC',''
        if code=='BP5/NNW':return 'AG_NNW',''
        if code in ['BP5/ZK','BP5/BEZPIECZNA_SZYBA']:return 'AG_RIDERS',''
        if code in ['BP5/ASSTUW','BP5/ASSST']:return 'AG_ASS',''
        return None,'Brak osobnej stawki dla tego kodu AGRO, np. utraty zniżek; nie rozciągamy stawki riders.'
    if tu == 'GENERALI':
        return {'OC':'GEN_OC','AC':'GEN_AC','NNW_MO':'GEN_NNW_MO','ASS':'GEN_ASS','HOME':'GEN_HOME','TRAVEL':'GEN_TRAVEL','NNW_GRUP':'GEN_NNW_GROUP','NNW_IND':'GEN_NNW_IND'}.get(code), 'Brak reguły dla kodu Generali.'
    if tu == 'EUROINS':
        return ('E_MOTOR','') if code in ['MTPL','PERSONAL ACCIDENT','ASSISTANCE'] else (None,'Nieznane ryzyko Euroins.')
    if tu=='OMINIMO':
        if not motor:return None,'OMINIMO: do zastosowania stawek motor potrzebne potwierdzenie komunikacyjnego rodzaju polisy.'
        if risk=='OC' and code in ['MTPL','OC']:return 'OM_OC',''
        if risk=='AC':return 'OM_AC',''
        if risk in ['AC MINI','MINI AC','MINICASCO']:return 'OM_MINI',''
        if risk in ['NNW','ASSISTANCE','SZYBY']:return 'OM_RIDERS',''
        return None,'Nieodwzorowane ryzyko OMINIMO.'
    if tu == 'WARTA':
        if ola:
            explicit={'WARTA TRAVEL':'OLA_W_TRAVEL','WARTA EKSTRABIZNES PLUS':'OLA_W_SME','SMARTBIZNES':'OLA_W_SMART',
                'WARTA TWOJE NNW':'OLA_W_PERSONAL_NNW','HDI TWOJ DOM':'OLA_W_HDI_HOME',
                'WARTA ROLNE':'OLA_W_FARM','HDI ROLNE':'OLA_W_HDI_FARM','WARTA OC SZYBKA WYPLATA':'OLA_W_FAST',
                'HDI AUTOCASCO +':'OLA_W_HDI_AC'}
            if code in explicit:return explicit[code],''
            if motor:
                motor_rules={'ASSISTANCE':'OLA_W_ASS','NNW':'OLA_W_NNW','SZYBY':'OLA_W_GLASSES','OPONY ASSISTANCE':'OLA_W_TYRES','EKSTRA 2000':'OLA_W_EXTRA'}
                if code in motor_rules:return motor_rules[code],''
        oc = code in ['OC INDYWIDUALNE','HDI UBEZP. OC - POSIADACZY POJAZDOW MECH','HDI ZIELONA KARTA']
        key = 'W_OC_ZP1' if oc and group=='ZP1' else 'W_OC' if oc else None
        if code in ['HDI AC POJAZDÓW MECHANICZNYCH','HDI AC POJAZDOW MECHANICZNYCH','AC KOMFORT','AUTOCASCO STANDARD','AUTOCASCO KOMFORT']: key='W_AC'
        if code=='WARTA DOM': key='W_HOME'
        if code=='WARTA DOM KOMFORT': key='W_HOME_PLUS'
        if code=='WARTA TRAVEL': key='W_TRAVEL'
        if ola and key and 'OLA_'+key in ['OLA_W_OC','OLA_W_OC_ZP1','OLA_W_AC','OLA_W_HOME','OLA_W_HOME_PLUS']: key='OLA_'+key
        elif ola: return None,'Nieodwzorowany wyjątek Oli dla tego ryzyka Warty.'
        return key,'Zbiorcza nazwa produktu lub brak ryzyka w tabeli Warty.'
    if tu == 'ERGO HESTIA' and profile=='IHESTIA':
        if risk=='OC': return 'H_OC',''
        if risk in ['AC','NNW','NNW, SZYBY','ASSISTANCE','NNW, ASSISTANCE']: return 'H_AC_RIDERS',''
    if tu == 'MTU':
        if profile=='YCD': return None,'Profil YCD i kod grupy MTU24.PL wymagają ustalenia właściwej tabeli.'
        if profile=='JUPITER (MTU)':
            if code=='A01': return 'MTU_NNW',''
            if code in ['S04','S16']: return None,'Mapowanie kodu MTU na assistance/szyby wymaga potwierdzenia.'
            if code in ['J07','J12'] and 'WZNOWIEN' in typ: return 'MTU_RENEW_OC',''
            return None,'Nieustalony próg inkasa MTU lub kod ryzyka.'
    if tu == 'PROAMA': return None,'Nieustalony sposób liczenia progu inkasa Proamy.'
    if tu == 'UNIQA':
        if profile=='UNIQA (POS)' and ola:
            pos={'MALY PAKIET':'OLA_U_POS_SMALL','DUZY PAKIET':'OLA_U_POS_BIG','KOCAUT':'OLA_U_POS_KOCAUT',
                'AC + ASSISTANCE AUTO PLUS24 (WARIANT BEZPLATNY)':'OLA_U_POS_AC_ASS'}
            if risk in pos:return pos[risk],''
            if code in pos:return pos[code],''
            return None,'POS/flota UNIQA: brak jednoznacznego wariantu w raporcie; nie stosujemy warunków panelu ani Flotiqa.'
        if profile!='UNIQA (PANEL AGENTA)': return None,'Tabela panelu agenta nie rozstrzyga automatycznie stawek profilu POS/flot.'
        explicit_ola={'OC MALA FLOTA FLOTIQA':'OLA_U_FLEET_OC','AC MALA FLOTA FLOTIQA':'OLA_U_FLEET_AC',
            'MSP / TWOJ BIZNES PLUS':'OLA_U_SME','TWOJE MIEJSCE / TWOJ DOM PLUS':'OLA_U_HOME','TURYSTYCZNE':'OLA_U_TRAVEL',
            'ROLNE':'OLA_U_FARM','ROBAUT / ROCAUT':'OLA_U_ROBAUT','ASSISTANCE W PODROZY':'OLA_U_TRAVEL_ASS',
            'OC ZAWODOWE PRZEWOZNIKA':'OLA_U_CARRIER','HEJT W INTERNECIE':'OLA_U_HEJT',
            'NNW GRUPOWE / WYPADEK & PRZEZORNOSC':'OLA_U_GROUP_NNW'}
        if ola and risk in explicit_ola:return explicit_ola[risk],''
        if risk.startswith('UBEZPIECZENIA KOMUNIKACYJNE: OC,'): key='U_OC'
        elif risk.startswith('UBEZPIECZENIA KOMUNIKACYJNE: NNW;'): key='U_RIDERS'
        elif 'AUTOCASCO' in risk or risk in ['AC','UBEZPIECZENIA KOMUNIKACYJNE: AC']: key='U_AC'
        elif risk=='NNW SZKOLNE': key='U_SCHOOL'
        else: return None,'Nieodwzorowana nazwa ryzyka UNIQA.'
        return ('OLA_'+key if ola else key),''
    if tu == 'WIENER':
        if code=='001' and risk=='OC': return 'WI_OC',''
        if code=='005' and risk=='AUTOCASCO': return 'WI_AC',''
        if code in ['004','006','074','219','064','384']: return 'WI_RIDERS',''
        if risk=='PAKIET "CZTERY KATY"': return 'WI_HOME',''
    if tu == 'COMPENSA':
        if risk=='OC': return 'C_OC',''
        if risk=='AC': return 'C_AC',''
        if risk=='NNW, ASSISTANCE POMOC, GAP, OCHRONA PRAWNA': return 'C_RIDERS',''
        if risk=='COMPENSA FIRMA, COMPENSA MOJ BIZNES': return 'C_SME',''
        if risk in ['UBEZPIECZENIE ROLNE','ROLNE']:return 'C_FARM',''
    if tu == 'ALLIANZ':
        has_ac = any(norm(r['risk_name'])=='AC' for r in policy_rows if r['insurer']==tu)
        has_oc = any(norm(r['risk_name'])=='OC' for r in policy_rows if r['insurer']==tu)
        if risk in ['OC','AC'] and has_oc and has_ac: return None,'Tabela zawiera OC+AC (15%), ale raport rozbija składkę na ryzyka; trzeba potwierdzić podstawę stawki pakietowej.'
        if risk=='MOJA FIRMA':return None,'W tabeli jest SME (28%), ale brak jednoznacznego powiązania produktu Moja Firma z tą kategorią. Poprzednie przypisanie było robocze.'
        return {'OC':'A_OC','AC':'A_AC','NNW':'A_NNW','OC+ RIDERS':'A_OC_RIDERS','OC + RIDERS':'A_OC_RIDERS','BEZPIECZNY DOM, BEZPIECZNY DOM PLUS, MOJ DOM':'A_HOME'}.get(risk),'Brak jednoznacznej pozycji w tabeli Allianz.'
    if tu == 'INTERRISK':
        if risk in ['OC','OC POJAZDOW LADOWYCH OSOBOWYCH']: return 'I_OC',''
        if risk in ['AC','UBEZPIECZENIE CASCO POJAZDOW LADOWYCH OSOBOWYCH']: return 'I_AC',''
        if risk=='AC PAKIET PO KRADZIEZY': return None,'Szczególne ryzyko AC po kradzieży: brak osobnej stawki w tabeli, nie stosujemy ogólnej stawki AC.'
    if tu == 'LINK4':
        if risk=='OC + RIDERS': return 'L_RIDERS',''
        if risk=='OC + AUTOCASCO': return 'L_PACKAGE',''
        if code=='TPL' and 'OBOWIAZKOWEGO UBEZPIECZENIA' in risk: return 'L_OC',''
    if tu == 'TUW TUW': return {'33':'TW_OC','14':'TW_AC','11':'TW_NNW','RG':'TW_HOME'}.get(code),'Nieodwzorowany kod TUW.'
    if tu=='TUZ':
        if motor and risk in ['OC','OC + RIDERS']:return 'TZ_OC',''
        if motor and risk=='AC':return 'TZ_AC',''
        if motor and risk in ['NNW','ASSISTANCE','SZYBY']:return 'TZ_RIDERS',''
        direct={'PAKIET DOM':'TZ_HOME','PAKIET ROLNIK':'TZ_FARM','PAKIET PRZEDSIEBIORCA':'TZ_SME',
            'OCK KROTKO TERMINOWE':'TZ_OC_SHORT','OCK GRANICZNE':'TZ_OC_BORDER','UBEZPIECZENIE UPRAW':'TZ_CROPS'}
        if risk in direct:return direct[risk],''
        return None,'TUZ: kod bez opisu lub OC Agenta nie ma odpowiednika w przekazanej tabeli; komunikacyjne OC nie jest OC zawodowym.'
    if tu == 'PZU':
        if 'INKASO OBCE' in group: return None,'Prowizja obsługowa kwotowa, poza procentową tabelą.'
        names = {norm(r['risk_code']) for r in policy_rows if r['insurer']=='PZU'}
        packaged = ('PZU AUTO OC' in names and 'PZU AUTO AC' in names) or 'PAKIET' in group
        if code in ['PZU AUTO OC','PZU AUTO AC'] and packaged: return None,'Możliwy pakiet PZU: trzeba rozstrzygnąć tabelę OC+AC+NNW.'
        renewal='WZNOWIENIE AKTYWNE' in group or 'WZNOWIENIE AKTYWNE' in typ
        new_business='NOWY BIZNES' in group or 'NOWY BIZNES' in typ
        if renewal and new_business:return None,'Sprzeczny rodzaj sprzedaży PZU: nowa i wznowienie aktywne w jednej pozycji.'
        suffix = '_RENEW' if renewal else '_NEW' if new_business else None
        if suffix is None: return None,'Nieustalony rodzaj sprzedaży PZU.'
        if code=='PZU AUTO OC': return 'PZU_OC'+suffix,''
        if code=='PZU AUTO AC': return 'PZU_AC'+suffix,''
        if code.startswith('PZU DOM '): return 'PZU_HOME'+suffix,''
        if risk=='PZU DORADCA, PZU FIRMA' or code=='PZU DORADCA': return 'PZU_SME'+suffix,''
    return None,'Brak jednoznacznego mapowania produktu/ryzyka do tabeli.'

def run(args):
    base=Path(args.source); out=Path(args.output)
    if (out/'wyniki.json').exists():
        initial=out; serial=2
        while (out/'wyniki.json').exists():
            out=initial.with_name(initial.name+f'_{serial:03d}');serial+=1
    out.mkdir(parents=True,exist_ok=True)
    active_file=ROOT/'presets'/'active-preset.json'
    active=json.loads(active_file.read_text(encoding='utf-8')) if not args.preset and active_file.exists() else None
    preset_path=Path(args.preset) if args.preset else ROOT/'presets'/active['filename'] if active else ROOT/'presets'/'preset-v1.json'
    if not preset_path.exists():
        if args.preset: raise FileNotFoundError(preset_path)
        preset_path.parent.mkdir(parents=True,exist_ok=True)
        preset_path.write_text(json.dumps(create_preset(base),ensure_ascii=False,indent=2),encoding='utf-8')
    preset=json.loads(preset_path.read_text(encoding='utf-8-sig'))
    client_resolver=None
    if preset.get('client_dictionary'):
        from .client_dictionary import ClientDictionaryResolver
        client_resolver=ClientDictionaryResolver(preset)
    if client_resolver is None:
        raise ValueError('Brak aktywnego słownika prowizji dla tej analizy.')
    confirmed=set(preset.get('confirmed_formats',[])) | set(args.confirm_format)
    begin=dt.date.fromisoformat(args.start); end=dt.date.fromisoformat(args.end)
    if end<begin: raise ValueError('Data końcowa wcześniejsza od początkowej.')
    manifest=[]; warnings_out=[]; policies={}; all_crm={}; records=[]; counter=collections.Counter()
    def register(f,typ):
        item={'file':str(f),'type':typ,'sha256':digest(f),'rows':0,'included':True};manifest.append(item);return item
    for f in sorted((base/'TABELA PROWIZJI').glob('*.xlsx')):
        entry=register(f,'TABELA');entry['rows']=None
        entry['included']=f.name=='PROPOZYCJA PROWIZJI.xlsx'
        entry['note']='Stawki w przebiegu pochodzą ze snapshotu presetu, plik jest materiałem odniesienia.'
    if preset.get('client_dictionary'):
        info=preset['client_dictionary']
        manifest.append({'file':info.get('source_name','aktywny słownik'),'type':'SLOWNIK_KLIENTA',
            'sha256':info['source_sha256'],'rows':info['stats']['entries'],'included':True,
            'note':'Niezmienna wersja słownika; stawki osobno dla Oli i Maćka.'})
    for f in sorted((base/'LISTA WYSTAWIONYCH POLIS').glob('*.xlsx')):
        reject_critical_formulas(f, {1, 2, 4, 8, 12, 16})
        entry=register(f,'CRM'); book=load_book(f)
        for sheet,rs in book.items():
            header=next((i for i,r in enumerate(rs[:15]) if r and clean(r[0])=='Nr. polisy'),None)
            if header is None: continue
            entry['recognized']=True
            for i,r in enumerate(rs[header+1:],header+2):
                if not r or not r[0]: continue
                entry['rows']+=1
                if len(r)<18: raise ValueError(f'Niepełny wiersz CRM {f.name}:{i}')
                d=r[3]
                if not isinstance(d,(dt.datetime,dt.date)):
                    warnings_out.append(f'Nieprawidłowa data wystawienia CRM: {f.name}, {sheet}, wiersz {i}.');continue
                d=d.date() if isinstance(d,dt.datetime) else d
                key=(brand(r[1]),number(r[0]))
                ref={'file':str(f),'sheet':sheet,'row':i}
                all_crm.setdefault(key,{'id':f'C{len(all_crm)+1:06}','insurer':key[0],
                    'number':clean(r[0]),'issued':d.isoformat(),'file':str(f),'sheet':sheet,'row':i})
                if not begin<=d<=end: continue
                if key in policies:
                    policies[key]['crm_refs'].append(ref);warnings_out.append(f'Powtórzona polisa CRM: {key[0]} {key[1]}.');continue
                policies[key]={'id':f'P{len(policies)+1:05}','number':clean(r[0]),'insurer':key[0],'raw_insurer':clean(r[1]),
                    'issued':d.isoformat(),'customer':clean(r[5]),'premium':r[8], 'crm_status':clean(r[15]),
                    'crm_agent':clean(r[11]),'product_group':clean(r[7]).split('/')[0].strip(),'crm_refs':[ref]}
        if not entry.get('recognized'): raise ValueError(f'Nie rozpoznano listy polis CRM: {f.name}')
    if not policies: raise ValueError('Brak polis CRM w wybranym okresie.')
    seen_files={}
    for folder,idx,header_name in [('ASF',8,'OFWCA imię i nazwisko (z pliku)'),('WARTA',2,'Numer OFWCA')]:
        for f in sorted((base/folder).glob('*.xlsx')):
            critical_columns = {2, 6, 7, 9, 11, 13, 15, 16, 17, 18, 22, 24} if folder == 'ASF' else {2, 3}
            reject_critical_formulas(f, critical_columns)
            entry=register(f,folder)
            if entry['sha256'] in seen_files:
                entry['included']=False;entry['duplicate_of']=seen_files[entry['sha256']];continue
            seen_files[entry['sha256']]=str(f)
            for sheet,rs in load_book(f).items():
                hi=next((i for i,r in enumerate(rs[:20]) if r and clean(r[0])==header_name),None)
                if hi is None: continue
                entry['recognized']=True
                for i,r in enumerate(rs[hi+1:],hi+2):
                    if len(r)<=idx or r[idx] is None or not r[1]: continue
                    if folder=='ASF' and len(r)<24: raise ValueError(f'Niepełny ASF {f.name}:{i}')
                    if folder=='WARTA' and len(r)<10: raise ValueError(f'Niepełna Warta {f.name}:{i}')
                    entry['rows']+=1
                    raw_tu,profile=(r[5],r[6]) if folder=='ASF' else ('WARTA','Bezpośrednia Warta')
                    row={'id':f'R{len(records)+1:06}','source_type':folder,'file':str(f),'sheet':sheet,'row':i,
                        'number':clean(r[idx]),'raw_insurer':clean(raw_tu),'insurer':brand(raw_tu,profile,r[idx]),'profile':clean(profile),
                        'agent':agent(r[1]),'ofwca':clean(r[1]),'ofwca_original':clean(r[0]),
                        'rate':r[10] if folder=='ASF' else None,'commission':r[11] if folder=='ASF' else float(Decimal(str(r[6] or 0))+Decimal(str(r[7] or 0))),
                        'inkaso':r[12] if folder=='ASF' else r[4],'risk_code':clean(r[15]) if folder=='ASF' else '',
                        'risk_name':clean(r[16]) if folder=='ASF' else '', 'group':clean(r[17]) if folder=='ASF' else '',
                        'type':clean(r[21]) if folder=='ASF' else '', 'note':clean(r[23]) if folder=='ASF' else '',
                        'contract_date':clean(r[14])[:10] if folder=='ASF' else ''}
                    records.append(row)
            if not entry.get('recognized'): raise ValueError(f'Nie rozpoznano raportu {folder}: {f.name}')
    exact=collections.defaultdict(list);alts=collections.defaultdict(list);by_num=collections.defaultdict(list)
    for row in records:
        exact[(row['insurer'],number(row['number']))].append(row);by_num[number(row['number'])].append(row)
        for key in alternative_keys(row['insurer'],row['number']): alts[(row['insurer'],key)].append(row)
    issues=[];unresolved=[];details=[];summaries=[]
    for policy in policies.values():
        status,matches,why=classify_match(policy,exact,alts,by_num,confirmed)
        policy['match_status']=status;policy['agents']=sorted({r['agent'] for r in matches})
        policy['sources']=sorted({r['source_type'] for r in matches});policy['report_numbers']=sorted({r['number'] for r in matches})
        policy['report_count']=len(matches);policy['wrong_rows']=0;policy['unchecked_rows']=0;policy['checked_rows']=0
        counter[status]+=1
        def item(kind,reason,row=None,rule=None):
            rr=row or {}; rule=rule or {}
            return {'policy_id':policy['id'],'kind':kind,'number':policy['number'],'report_number':rr.get('number',''),
                'insurer':policy['insurer'],'issued':policy['issued'],'customer':policy['customer'],'crm_status':policy['crm_status'],
                'agent':rr.get('agent',' / '.join(policy['agents']) or 'Nieustalony'),'source_type':rr.get('source_type',''),
                'risk':rr.get('risk_name') or rr.get('risk_code',''),'profile':rr.get('profile',''),
                'risk_code':rr.get('risk_code',''),'risk_name':rr.get('risk_name',''),
                'group':rr.get('group',''),'sale_type':rr.get('type',''),'contract_date':rr.get('contract_date',''),
                'raw_report_insurer':rr.get('raw_insurer',''),
                'normalized_crm_number':normalized_number(policy['insurer'],policy['number']),
                'normalized_report_number':normalized_number(rr.get('insurer',policy['insurer']),rr.get('number','')),
                'actual_rate':rr.get('rate'),'expected_rate':rule.get('rate'),
                'difference_pp':float(rate_decimal(rr['rate'])-rate_decimal(rule['rate'])) if rr.get('rate') is not None and rule.get('rate') is not None else None,
                'commission':rr.get('commission'),'inkaso':rr.get('inkaso'),'reason':reason,
                'rule_id':rr.get('rule_id',''),'rule_label':rule.get('label',''),'rule_source':f"{rule.get('sheet','')}!{rule.get('cell','')}" if rule else '',
                'file':rr.get('file',''),'sheet':rr.get('sheet',''),'row':rr.get('row'),
                'crm_file':policy['crm_refs'][0]['file'],'crm_sheet':policy['crm_refs'][0]['sheet'],'crm_row':policy['crm_refs'][0]['row'],
                'candidates':'; '.join(policy['report_numbers']) if status=='DO_POTWIERDZENIA' else ''}
        if status=='BRAK': issues.append(item('BRAK_PROWIZJI',why))
        elif status=='DO_POTWIERDZENIA':
            unresolved.append(item('DOPASOWANIE_NUMERU',why))
            for row in matches: details.append(item('DOPASOWANIE_NUMERU',why,row))
        else:
            if len(policy['agents'])>1: unresolved.append(item('ROZNI_AGENCI','Pozycje tej polisy wskazują więcej niż jednego OFWCA.'))
            for row in matches:
                rid,reason=select_rule(row,policy,matches)
                if client_resolver:rid,reason=client_resolver.resolve(row,policy,matches,rid,reason)
                rule=preset['rules'].get(rid)
                if rid and not rule:
                    reason=f'Brak wymaganej stawki {rid} w wybranej wersji presetu.';rid=None
                row={**row,'rule_id':rid or ''}
                if rule and rate_decimal(row['rate']) is not None:
                    state=rate_status(row['rate'],rule['rate']);policy['checked_rows']+=1
                    msg='Porównano procent z tabelą; zastosowano aktualną wersję do całego badanego okresu.'
                    rec=item(state,msg,row,rule)
                    if state=='BLEDNY_PROCENT':issues.append(rec);policy['wrong_rows']+=1
                else:
                    rec=item('BRAK_WERYFIKACJI_PROCENTU',reason or 'Brak procentu w raporcie.',row)
                    unresolved.append(rec);policy['unchecked_rows']+=1
                details.append(rec)
        policy['result']='BRAK_PROWIZJI' if status=='BRAK' else 'DOPASOWANIE_NUMERU' if status=='DO_POTWIERDZENIA' else 'BLEDNY_PROCENT' if policy['wrong_rows'] else 'CZESCIOWA_WERYFIKACJA' if policy['unchecked_rows'] else 'SPRAWDZONE_POZYCJE_ZGODNE'
        if norm(policy['crm_status'])=='ANULOWANA': warnings_out.append(f'Polisa {policy["number"]} jest anulowana w CRM; pozostawiona w wyniku do oceny.')
        summaries.append(policy)
    reverse=reverse_audit(list(all_crm.values()),records,confirmed,begin,end)
    assumptions=[
      'Polisy wybiera data wystawienia CRM; obie daty graniczne są włączone.',
      'Przeszukiwane są wszystkie dostarczone raporty, niezależnie od miesiąca rozliczenia.',
      'Brak oznacza brak w dostarczonych plikach, nie dowód niewypłacenia należnej prowizji.',
      'Aktualne tabele stosowane eksperymentalnie do całego okresu; historia obowiązywania nie jest znana.',
      'Różnice procentów są rozbieżnościami względem presetu, wymagają oceny biznesowej przed reklamacją.',
      'OFWCA określa właściciela prowizji; sprzedawca CRM nie zastępuje OFWCA.',
      'Niepewne formaty numerów i różnice marki są wyłączone z listy pewnych braków.',
      'Dla Warty bezpośredniej nie obliczamy procentu z kwot i zerowego inkasa.',
      'Zwroty, zerowe inkaso i nieustalone pakiety/progi/ryzyka są nierozstrzygnięte.',
      'Obecność pozycji nie potwierdza kompletności wszystkich ryzyk, rat ani faktycznej wypłaty.',
      'Anulowane polisy pozostawiono z jawnym statusem CRM; reguła ich wyłączania nie jest ustalona.',
      'Kwoty nie są sumowane jako niedopłata; stawka procentowa jest porównywana bez zaokrąglania do pełnych punktów.',
      'Nie deduplikujemy jednakowych wierszy rozliczeń, bo mogą oznaczać odrębne raty. Identyczny plik liczony raz w przebiegu.',
      'Brak PESEL, REGON i telefonów w raporcie; dane identyfikacyjne klienta ograniczono do nazwy z CRM.'
    ]
    summary={'policies':len(summaries),'missing_policies':sum(p['result']=='BRAK_PROWIZJI' for p in summaries),
        'candidate_policies':sum(p['result']=='DOPASOWANIE_NUMERU' for p in summaries),
        'matched_policies':sum(p['match_status'] in ['DOKLADNE','FORMAT_PRZYJETY'] for p in summaries),
        'wrong_rate_rows':sum(r['kind']=='BLEDNY_PROCENT' for r in issues),
        'wrong_rate_policies':len({r['policy_id'] for r in issues if r['kind']=='BLEDNY_PROCENT'}),
        'checked_rate_rows':sum(p['checked_rows'] for p in summaries),
        'unverified_rate_rows':sum(p['unchecked_rows'] for p in summaries),
        'report_records':len(records),'duplicate_files':sum(bool(f.get('duplicate_of')) for f in manifest)}
    if confirmed: assumptions.append('Roboczo przyjęte uproszczenia numerów: '+', '.join(sorted(confirmed))+'. Nie oznacza to ustalenia znaczenia prefiksów ani sufiksów.')
    if client_resolver:
        assumptions.append('Użyto uzupełnionego słownika klienta z 05.11.2026. Brak oferowania / nierozpoznany kod nie usuwa faktycznych rozliczeń z audytu. Tylko jednoznaczne „za to nie ma prowizji” oznacza 0%.')
    data={'start':args.start,'end':args.end,'summary':summary,'preset_version':preset['version'],
        'preset_sha256':digest(preset_path),'engine_sha256':digest(Path(__file__)),
        'generated_at':dt.datetime.now(dt.timezone.utc).isoformat(),'confirmed_formats':sorted(confirmed),
        'assumptions':assumptions,'warnings':warnings_out,'manifest':manifest,
        'issues':issues,'unresolved':unresolved,'policies':summaries,'details':details,'rules':preset['rules'],
        'reverse_audit':reverse}
    (out/'wyniki.json').write_text(json.dumps(data,ensure_ascii=False,indent=2,default=str),encoding='utf-8')
    return data
