# WordPress figyelő – Origó-Ház Civilház

Ez a figyelő 15 percenként megnyitja az oldal fontosabb aloldalait asztali, tablet és mobil méretben. Hibát keres rajtuk, és összeveti a kinézetüket egy korábban elfogadott állapottal. Ha valami elromlik, értesítést küld. A futtatás a GitHub Actions szolgáltatásban történik, ingyenesen, saját szerver nélkül.

## Mit vesz észre?

| Hiba | Súlyosság |
|---|---|
| Az oldal nem tölt be, vagy 4xx/5xx hibakódot ad | kritikus |
| Idegen domainre irányít át (feltört oldal jele lehet) | kritikus |
| WordPress/PHP hibaüzenet az oldalon („Kritikus hiba…”, `Warning: … on line …`) | kritikus |
| Nem töltődik be egy saját CSS-fájl (pl. LiteSpeed- vagy Divi-gyorsítótár hiba után) | kritikus |
| Szétcsúszott elrendezés: az oldal teteje látványosan eltér az elfogadott képtől | hiba |
| Az oldal oldalra kilóg, vízszintesen görgethető (a kilógó elemet is megnevezi) | hiba |
| Nem jelenik meg egy kép, betűtípus vagy JavaScript-fájl | hiba |
| JavaScript-hiba (pl. nem nyílik a menü) | hiba |
| Eltűnt a fejléc vagy a lábléc, megváltozott a betűtípus, kevesebb stíluslap működik | hiba |
| Lassú betöltés, konzolhibák, megváltozott oldalhossz | figyelmeztetés (nem riaszt, csak a riportban szerepel) |

A változó tartalmak (hírlista, eseménynaptár) ki vannak takarva a képösszehasonlításból, így egy új hír nem okoz téves riasztást. A süti-sávot a figyelő elrejti.

**Hogy ne legyen sok fölösleges riasztás:**
- A kritikus hibákról azonnal szól, a sima hibákról csak akkor, ha két egymást követő ellenőrzésnél is fennállnak.
- Ugyanarról a hibáról 12 óránként legfeljebb egyszer szól. Amikor megszűnik, arról is küld értesítést.
- Az egy eseményhez tartozó hibák (pl. egy hiányzó CSS-fájl minden oldalon) egyetlen üzenetbe kerülnek.
- A már meglévő hibák az első futáskor „ismertként” rögzülnek, ezekért nem riaszt.

## Beüzemelés (kb. 10 perc)

1. **GitHub-tároló.** Hozz létre egy új tárolót (repository) a github.com-on, például `wp-figyelo` néven, és állítsd **Public**-ra. Nyilvános tárolóban a GitHub Actions korlátlanul ingyenes. Privát tárolóban havi 2000 ingyenes perc jár, ez a 15 percenkénti futáshoz nem elég. Ilyenkor a `.github/workflows/figyelo.yml` fájlban írd át az ütemezést `'0 */2 * * *'`-ra (kétóránként).
2. **Fájlok feltöltése.** Töltsd fel a csomag teljes tartalmát: *Add file → Upload files*, majd húzd be a mappák tartalmát. A `.github` mappa Macen és Windowson rejtett lehet. Ha nem látod, a tárolóban válaszd az *Add file → Create new file* lehetőséget, fájlnévnek írd be: `.github/workflows/figyelo.yml`, és másold bele a fájl tartalmát.
3. **Első futás.** A tárolóban: *Actions* fül → bal oldalt *WordPress figyelő* → *Run workflow* → a „Mit csináljon?” mezőben válaszd az `alapallapot-frissites` lehetőséget → *Run workflow*. Ez rögzíti a jelenlegi állapotot, és innentől 15 percenként automatikusan fut.
4. **E-mail értesítés.** GitHub jobb felső sarok → *Settings → Notifications → System → Actions*: legyen bekapcsolva az *Email* és az *Only notify for failed workflows*. Ha a figyelő új hibát talál, a futás „elbukik”, és a GitHub e-mailt küld róla.

### Telefonos push értesítés (opcionális, ajánlott)

1. Telepítsd az **ntfy** alkalmazást (Android/iOS), és iratkozz fel egy nehezen kitalálható témára, például `origohaz-figyelo-k7q2m9x`. A témanév nyilvános, ezért ne legyen egyszerű.
2. A GitHub-tárolóban: *Settings → Secrets and variables → Actions → New repository secret*. Név: `NTFY_TOPIC`, érték: a témanév.

### Slack (opcionális)

Hozz létre egy Slack „Incoming Webhook”-ot, és mentsd el `SLACK_WEBHOOK_URL` néven a fenti módon.

## Használat

**Hol látom, mi történt?** *Actions* fül → kattints egy futásra. A *Summary* oldalon táblázat mutatja a találatokat. Ha volt hiba, lent az *Artifacts* résznél letölthető a `riport-…` csomag. Benne az `index.html` megmutatja a képernyőképeket (előtte–most–eltérés) és a teljes oldalas képeket.

**Szándékosan módosítottam az oldalt (új fejléckép, új menüpont).** Ilyenkor a figyelő eltérést jelez. Ha az új kinézet a jó, futtasd újra az *Run workflow → alapallapot-frissites* lépést, és onnantól az lesz az elfogadott állapot.

**Új aloldalt akarok figyelni.** Vedd fel a `config.json` `oldalak` listájába. Az első futáskor automatikusan elkészül hozzá az alapállapot.

## Beállítások (`config.json`)

| Mező | Jelentés |
|---|---|
| `alapUrl` | A figyelt WordPress-oldal címe |
| `oldalak` | A figyelt aloldalak (`nev` = rövid azonosító, `utvonal` = az alapcím utáni rész) |
| `nezetek` | Képernyőméretek |
| `elemek` | A fejléc, lábléc és szekciók CSS-választói (Divi-hez beállítva) |
| `elrejtendo` | Képernyőkép előtt elrejtett elemek (süti-sáv) |
| `maszkolando` | Változó tartalmú részek, amelyeket a képösszehasonlítás kitakar |
| `blokkolt` | Ezeket a címeket a figyelő nem tölti be (analitika), hogy ne torzítsa a látogatottsági statisztikát |
| `hatarertekek.kepElteresSzazalek` | Ennyi % képeltérés felett jelez (alapból 3) |
| `riasztas.megerosites` | Hány egymást követő futásnál kell látni egy hibát a riasztáshoz |
| `riasztas.ujraRiasztasOra` | Ennyi óránként emlékeztet a fennálló hibára |
| `hibaSzovegek` | Szövegminták (reguláris kifejezések), amelyek az oldalon hibát jeleznek |
| `figyelmenKivul` | URL- és konzolüzenet-részletek, amelyeket nem kell hibának venni |

## Jó tudni

- **Késés.** A GitHub ütemezett futásai terhelés idején késhetnek, ritkán ki is maradhatnak. Ezért a „15 percenként” a gyakorlatban 15–30 percet jelent.
- **Inaktivitás.** Nyilvános tárolóban a GitHub 60 nap tétlenség után leállítja az ütemezést. A figyelő ezt magától megelőzi: 45 naponta egy üres „életjel” commitot ír.
- **Látogatottsági statisztika.** A figyelő böngészője `WPFigyelo/1.0` azonosítóval jelentkezik, és nem tölti be a Google Analyticset. Ha egy WordPress-statisztika bővítmény mégis számolja a látogatásait, ezt az azonosítót érdemes kizárni.
- **Helyi futtatás (fejlesztőknek):** `npm ci && npx playwright install chromium && node src/figyelo.mjs`
