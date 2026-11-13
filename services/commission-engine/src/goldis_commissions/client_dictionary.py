"""Versioned import of the client's dictionary; never executes workbook macros."""
from __future__ import annotations
import argparse,collections,datetime as dt,hashlib,json,re,unicodedata
from decimal import Decimal
from io import BytesIO
from pathlib import Path
import openpyxl
from goldis_commissions.importers.workbook import validate_workbook

def key(value):
    value='' if value is None else str(value).strip()
    value=unicodedata.normalize('NFKD',value.replace('ł','l').replace('Ł','L'))
    return ' '.join(''.join(c for c in value if not unicodedata.combining(c)).upper().split())

def hash_file(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def parse_rate(value,number_format='General'):
    if isinstance(value,bool):raise ValueError('Wartość logiczna nie jest procentem prowizji.')
    if isinstance(value,(int,float,Decimal)):
        # Quoted or escaped percent is a literal, e.g. 15 with 0.00"%".
        fmt=re.sub(r'"[^"]*"|\\.', '',number_format)
        rate=Decimal(str(value))*(100 if '%' in fmt else 1)
        if not rate.is_finite() or rate<0:raise ValueError(f'Nieprawidłowy procent: {value}')
        return {'status':'RATE','rate':float(rate),'raw':value,'number_format':number_format}
    text=key(value)
    if text.startswith('='):raise ValueError('Formuła w polu stawki wymaga zapisanej wartości, nie jest wykonywana przy imporcie.')
    if text in ['','BRAK']:status='MISSING'
    elif text=='ZA TO NIE MA PROWIZJI':return {'status':'NO_COMMISSION','rate':0.0,'raw':value,'number_format':number_format}
    elif text.startswith('NIE WIEM'):status='UNKNOWN_CODE'
    elif any(s in text for s in ['NIE SPRZEDAJEMY','NIE WYSTAWIAM','NIE MAM U SIEBIE','NIE MAM TAKIEGO','NA MACKU NIE MA']):status='NOT_OFFERED'
    elif 'NIE MA ZDEFINIOWANEJ STAWKI' in text:status='NO_DEFINED_RATE'
    elif 'INDYWIDUAL' in text or 'SUATALA SIE' in text:status='INDIVIDUAL'
    else:
        m=re.fullmatch(r'(\d+(?:[,.]\d+)?)\s*(%)?',str(value).strip())
        if m:return {'status':'RATE','rate':float(Decimal(m[1].replace(',','.'))),'raw':value,'number_format':number_format}
        raise ValueError(f'Nieobsługiwany opis stawki: {value!r}')
    return {'status':status,'rate':None,'raw':value,'number_format':number_format}

def import_dictionary(source,baseline_path,previous_path,version,archive_source=None):
    source=Path(source);source_bytes=source.read_bytes();validate_workbook(source_bytes,source.suffix.lower())
    baseline=json.loads(Path(baseline_path).read_text(encoding='utf-8'))
    previous=json.loads(Path(previous_path).read_text(encoding='utf-8-sig'))
    old={(key(r['tu']),key(r['risk']),key(r['variant'])):r for r in baseline['dictionary']}
    book=openpyxl.load_workbook(BytesIO(source_bytes),read_only=False,data_only=False)
    entries=[];changes=[];seen=set();statuses=collections.Counter();new_rates=0
    for sheet in book:
        if sheet.max_column>6 and any(c.value is not None for row in sheet.iter_rows(min_col=7) for c in row):
            raise ValueError(f'Nieoczekiwane dodatkowe dane w {sheet.title}.')
        if [sheet.cell(7,c).value for c in range(1,4)]!=['Towarzystwo','Rodzaj ryzyka','Wariant']:
            raise ValueError(f'Nie rozpoznano nagłówków słownika: {sheet.title}')
        for i in range(8,sheet.max_row+1):
            cells=[sheet.cell(i,j) for j in range(1,7)];values=[c.value for c in cells]
            if not any(v is not None for v in values):continue
            tu,risk,variant=values[:3];k=(key(tu),key(risk),key(variant))
            if k not in old:raise ValueError(f'Nowy / zmieniony klucz słownika wymaga jawnego powiązania: {sheet.title}:{i}: {k}')
            if k in seen:raise ValueError(f'Powtórzony klucz słownika: {k}')
            seen.add(k);before=old[k]
            entry={'id':before.get('entry_id',f'SL-{len(entries)+1:04d}'),'tu':tu,'risk':risk,'variant':variant,
                'notes':values[5] or '', 'original_notes':before['notes'],'legacy_rules':before['rules'],
                'source':str(archive_source or source),'source_original':str(source),'sheet':sheet.title,'row':i,'agents':{}}
            for person,col,old_key in [('Ola',3,'ola'),('Maciek',4,'maciek')]:
                parsed=parse_rate(values[col],cells[col].number_format)
                previous_value=before[old_key]
                changed=parsed['rate']!=previous_value or parsed['status'] not in ['RATE','MISSING']
                parsed.update(cell=cells[col].coordinate,changed=changed)
                parsed['rule_id']=f"CLIENT_{entry['id'].replace('-','_')}_{person.upper()}" if parsed['rate'] is not None else None
                entry['agents'][person]=parsed;statuses[parsed['status']]+=1
                if changed:
                    changes.append({'entry_id':entry['id'],'tu':tu,'risk':risk,'variant':variant,'agent':person,
                        'before':previous_value,'after':parsed['rate'],'status':parsed['status'],'raw':parsed['raw'],'cell':cells[col].coordinate})
                    if previous_value is None and parsed['rate'] is not None:new_rates+=1
            entries.append(entry)
    book.close()
    if seen!=set(old):raise ValueError('Słownik nie obejmuje wszystkich dotychczasowych pozycji; import nie usuwa ich milcząco.')
    rules=dict(previous['rules'])
    for e in entries:
        for person,a in e['agents'].items():
            if a['rate'] is None:continue
            rules[a['rule_id']]={'rate':a['rate'],'label':e['risk'],'source':e['source'],'sheet':e['sheet'],'cell':a['cell'],
                'source_value':a['raw'],'number_format':a['number_format'],'owner':person,'entry_id':e['id'],
                'variant':e['variant'],'status':a['status'],'origin':'client_dictionary'}
    meta={'version':version,'previous_version':previous['version'],'imported_at':dt.datetime.now(dt.timezone.utc).isoformat(),
        'source':str(archive_source or source),'source_original':str(source),'source_sha256':hashlib.sha256(source_bytes).hexdigest(),
        'baseline_sha256':hash_file(baseline_path),'previous_preset_sha256':hash_file(previous_path),'entries':entries,
        'stats':{'entries':len(entries),'companies':len(book.sheetnames),'agent_statuses':dict(statuses),'changed_agent_values':len(changes),'new_numeric_rates':new_rates},
        'changes':changes}
    preset={**previous,'version':version,'previous_version':previous['version'],'created_at':meta['imported_at'],
        'description':'Wersja słownika klienta z 05.11.2026. Stawki oddzielne dla OFWCA, jawne statusy odpowiedzi tekstowych; historia poprzednich wersji zachowana.',
        'rules':rules,'client_dictionary':meta}
    return preset

def import_client_workbook(source,version,source_name='slownik.xlsx',previous_preset=None):
    """Build a self-contained, immutable engine snapshot from the six-column workbook."""
    source=Path(source)
    source_bytes=source.read_bytes()
    validate_workbook(source_bytes,source.suffix.lower())
    safe_name=Path(str(source_name).replace('\\','/')).name[:180] or 'slownik.xlsx'
    mapping_path=Path(__file__).with_name('dictionary-v7-mapping.json')
    mapping=json.loads(mapping_path.read_text(encoding='utf-8'))
    old={(key(e['tu']),key(e['risk']),key(e['variant'])):e for e in mapping['entries']}
    previous_by_key={}
    if previous_preset:
        previous_by_key={(key(e['tu']),key(e['risk']),key(e['variant'])):e
            for e in previous_preset.get('client_dictionary',{}).get('entries',[])}
    book=openpyxl.load_workbook(BytesIO(source_bytes),read_only=False,data_only=False,keep_vba=False)
    if len(book.sheetnames)>40:
        book.close();raise ValueError('WORKBOOK_LIMITS_EXCEEDED: zbyt wiele arkuszy.')
    entries=[];seen=set();statuses=collections.Counter();rules={};new_rates=0
    for sheet in book:
        if sheet.max_row>25_000 or sheet.max_column>64:
            book.close();raise ValueError(f'WORKBOOK_LIMITS_EXCEEDED:{sheet.title}')
        if [sheet.cell(7,c).value for c in range(1,4)]!=['Towarzystwo','Rodzaj ryzyka','Wariant']:
            book.close();raise ValueError(f'Nie rozpoznano nagłówków słownika: {sheet.title}')
        if sheet.max_column>6 and any(c.value is not None for row in sheet.iter_rows(min_col=7) for c in row):
            book.close();raise ValueError(f'Nieoczekiwane dodatkowe dane w {sheet.title}.')
        for i in range(8,sheet.max_row+1):
            cells=[sheet.cell(i,j) for j in range(1,7)];values=[c.value for c in cells]
            if not any(v is not None for v in values):continue
            if not all(values[j] is not None and str(values[j]).strip() for j in range(3)):
                book.close();raise ValueError(f'Brak TU, ryzyka lub wariantu: {sheet.title}:{i}')
            tu,risk,variant=values[:3];k=(key(tu),key(risk),key(variant))
            if k in seen:
                book.close();raise ValueError(f'Powtórzony klucz słownika: {sheet.title}:{i}')
            seen.add(k);before=old.get(k)
            entry_id=before['entry_id'] if before else 'NEW-'+hashlib.sha256('\x1f'.join(k).encode()).hexdigest()[:16].upper()
            entry={'id':entry_id,'tu':str(tu).strip(),'risk':str(risk).strip(),'variant':str(variant).strip(),
                'notes':str(values[5] or '').strip(),'original_notes':'','legacy_rules':list(before.get('legacy_rules',[])) if before else [],
                'source':safe_name,'source_original':safe_name,'sheet':sheet.title,'row':i,'agents':{}}
            for person,col in [('Ola',3),('Maciek',4)]:
                try:parsed=parse_rate(values[col],cells[col].number_format)
                except ValueError as exc:
                    book.close()
                    if isinstance(values[col],str) and values[col].startswith('='):
                        raise ValueError(f'FORMULA_REQUIRES_VALUE:{sheet.title}!{cells[col].coordinate}') from exc
                    raise ValueError(f'{sheet.title}!{cells[col].coordinate}: {exc}') from exc
                previous_entry=previous_by_key.get(k)
                if previous_entry:
                    old_agent=previous_entry.get('agents',{}).get(person,{})
                    changed=bool(old_agent.get('changed')) or parsed['status']!=old_agent.get('status') or parsed['rate']!=old_agent.get('rate')
                elif before:
                    changed=bool(before.get('agent_overrides',{}).get(person,True))
                else:
                    changed=True
                rule_id=f"CLIENT_{entry_id.replace('-','_')}_{person.upper()}" if parsed['rate'] is not None else None
                parsed.update(cell=cells[col].coordinate,changed=changed,rule_id=rule_id)
                entry['agents'][person]=parsed;statuses[parsed['status']]+=1
                if rule_id:
                    rules[rule_id]={'rate':parsed['rate'],'label':entry['risk'],'source':safe_name,'sheet':sheet.title,
                        'cell':cells[col].coordinate,'source_value':str(parsed['raw']),'number_format':parsed['number_format'],
                        'owner':person,'entry_id':entry_id,'variant':entry['variant'],'status':parsed['status'],'origin':'client_dictionary'}
                    if before is None:new_rates+=1
            entries.append(entry)
    book.close()
    missing=set(old)-seen
    if missing:
        raise ValueError(f'SLOWNIK_INCOMPLETE: brakuje {len(missing)} dotychczasowych pozycji. Uzupełnij je statusem BRAK zamiast usuwać wiersze.')
    if not entries:raise ValueError('Słownik nie zawiera żadnych pozycji.')
    sha=hashlib.sha256(source_bytes).hexdigest()
    return {'version':version,'previous_version':None,'created_at':dt.datetime.now(dt.timezone.utc).isoformat(),
        'description':'Niezmienny snapshot słownika prowizji importowany z pliku klienta.',
        'confirmed_formats':list(mapping.get('confirmed_formats',[])),'rules':rules,
        'client_dictionary':{'version':version,'previous_version':None,'imported_at':dt.datetime.now(dt.timezone.utc).isoformat(),
            'source':safe_name,'source_original':safe_name,'source_name':safe_name,'source_sha256':sha,
            'baseline_sha256':hash_file(mapping_path),'previous_preset_sha256':None,'entries':entries,
            'stats':{'entries':len(entries),'companies':len(book.sheetnames),'agent_statuses':dict(statuses),
                'changed_agent_values':len(entries)*2,'new_numeric_rates':new_rates},'changes':[]}}

class ClientDictionaryResolver:
    def __init__(self,preset):
        self.preset=preset;self.direct=collections.defaultdict(list);self.legacy={};self.explicit_aliases=set()
        for e in preset.get('client_dictionary',{}).get('entries',[]):
            self.direct[key(e['tu']),key(e['risk'])].append(e)
            if key(e['tu'])=='WARTA' and key(e['risk']).startswith('HDI / '):
                alias='HDI '+key(e['risk'])[6:]
                self.direct['WARTA',alias].append(e);self.explicit_aliases.add(('WARTA',alias))
            for rid in e['legacy_rules']:
                if rid in self.legacy:raise ValueError(f'Niejednoznaczna reguła źródłowa: {rid}')
                self.legacy[rid]=e
        # Literal product-name correspondences, not matches by observed percent.
        aliases={('WARTA','HDI ZIELONA KARTA'):'OC PPM W RUCHU ZAGRANICZNYM (HDI ZIELONA KARTA)',
            ('WARTA','WARTA ZIELONA KARTA'):'OC PPM W RUCHU ZAGRANICZNYM (WARTA ZIELONA KARTA)',
            ('WARTA','WARTA TRAVEL'):'TRAVEL'}
        for (tu,alias),label in aliases.items():
            entries=self.direct.get((tu,key(label)),[])
            if entries:self.direct[tu,alias].extend(entries);self.explicit_aliases.add((tu,alias))

    def resolve(self,row,policy,policy_rows,legacy_id,legacy_reason):
        if not self.preset.get('client_dictionary'):return legacy_id,legacy_reason
        person=row['agent'];tu=key(row['insurer']);profile=key(row.get('profile',''))
        try:inkaso=Decimal(str(row.get('inkaso')))
        except Exception:inkaso=None
        if row['source_type']=='WARTA' or person not in ['Ola','Maciek'] or (inkaso is not None and Decimal(str(inkaso))<=0) or 'KOREKT' in key(row.get('note','')) or 'ZWROT' in key(row.get('type','')):
            return legacy_id,legacy_reason
        names={key(row.get('risk_name','')),key(row.get('risk_code',''))}-{''}
        matches={}
        for n in names:
            for e in self.direct.get((tu,n),[]):
                if (e['agents'][person]['changed'] or (tu,n) in self.explicit_aliases) and self._variant_matches(e,row):matches[e['id']]=e
            if tu=='UNIQA' and profile=='UNIQA (POS)':
                for e in self.direct.get((tu,'POS / '+n),[]):
                    if e['agents'][person]['changed'] and self._variant_matches(e,row):matches[e['id']]=e
        if len(matches)>1:return None,'Słownik klienta wskazuje kilka różnych pozycji dla kodu i nazwy ryzyka; wymaga rozstrzygnięcia.'
        if matches:
            e=next(iter(matches.values()));a=e['agents'][person]
            # Generic motor OC/AC/NNW do not resolve package or profile conditions.
            if key(e['risk']) in ['OC','AC','NNW','ASSISTANCE','SZYBY','OPONY ASSISTANCE','EKSTRA 2000']:
                if 'PAKIET' in key(legacy_reason) and tu!='PROAMA':return legacy_id,legacy_reason
                if tu=='UNIQA' and profile!='UNIQA (PANEL AGENTA)':return legacy_id,legacy_reason
                if tu=='WARTA' and 'KOMUNIKACYJNE' not in key(policy.get('product_group','')):return legacy_id,legacy_reason
            return self._decision(e,person)
        if legacy_id in self.legacy:return self._decision(self.legacy[legacy_id],person)
        return legacy_id,legacy_reason

    @staticmethod
    def _variant_matches(entry,row):
        variant=key(entry['variant']);sale=key(row.get('type',''))+' '+key(row.get('group',''))
        if variant=='NIE WSKAZANO':return True
        if variant=='WZNOWIENIE AKTYWNE':return 'WZNOWIENIE AKTYWNE' in sale and 'NOWY BIZNES' not in sale
        if variant=='NOWY':return 'NOWY BIZNES' in sale and 'WZNOWIENIE AKTYWNE' not in sale
        if variant=='WZNOWIENIE':return 'WZNOW' in sale
        if variant=='NOWY KLIENT':return 'POZYSKANIE NOWEGO KLIENTA' in sale
        return False

    @staticmethod
    def _decision(entry,person):
        a=entry['agents'][person]
        if a['rate'] is not None:return a['rule_id'],''
        labels={'MISSING':'Brak stawki w słowniku klienta','UNKNOWN_CODE':'Klient nie rozpoznał kodu / produktu',
            'NOT_OFFERED':'Klient zadeklarował, że nie oferuje tego produktu','NO_DEFINED_RATE':'Klient nie podał zdefiniowanej stawki',
            'INDIVIDUAL':'Stawka ustalana indywidualnie; brak jednej wartości'}
        return None,f"{labels[a['status']]} dla {person}: {a['raw'] or 'BRAK'}. Pozycja {entry['sheet']}!{a['cell']}. Rozliczenie pozostaje w audycie."

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True);parser.add_argument('--baseline',required=True)
    parser.add_argument('--previous-preset',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--version',required=True);parser.add_argument('--archive-source')
    args=parser.parse_args();output=Path(args.output)
    if output.exists():raise FileExistsError('Wersje słownika są niezmienne; podaj nową ścieżkę / wersję.')
    preset=import_dictionary(args.source,args.baseline,args.previous_preset,args.version,args.archive_source)
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(preset,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'preset':str(output),'stats':preset['client_dictionary']['stats']},ensure_ascii=False))
