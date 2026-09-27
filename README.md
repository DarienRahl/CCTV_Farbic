# CCTV – kamery na żywo dla serwera Minecraft (Fabric 26.3)

Mod **tylko po stronie serwera**. Stawiasz komendą „kamerę” w świecie, a jej obraz na żywo
oglądasz w przeglądarce: gracze, moby, otwierane drzwi i stawiane bloki widać od razu.

- **Gracze nie potrzebują moda.** Wchodzą na serwer zwykłym klientem vanilla.
- **Bez dodatkowego konta Minecraft i bez bota.** Nikt nie musi być zalogowany, żeby kamera działała.
- **Serwer nie renderuje obrazu i nie potrzebuje GPU.** Wysyła tylko lekkie dane: bloki, światło,
  biomy i pozycje encji 20 razy na sekundę. Całe renderowanie robi przeglądarka (WebGL2).
- **Wygląd jak w Minecrafcie.** Są oryginalne tekstury i modele bloków, *smooth lighting* z ambient
  occlusion, lightmapa dnia i nocy, pochodnie, kolory biomów (trawa, liście, woda), animowana woda
  i lawa, słońce, księżyc z fazami, gwiazdy i chmury. Moby mają modele i tekstury z gry, gracze
  swoje skiny i zbroje. Są też skrzynie, przedmioty na ziemi i w rękach, cienie pod mobami oraz
  świecące oczy pająków i endermanów.

## Wymagania

- serwer **Fabric** dla Minecraft **26.3** (Fabric Loader ≥ 0.19.5),
- **Fabric API**,
- **Java 25**.

## Instalacja

1. Weź plik `cctv-fabric-<wersja>.jar`:
   - z zakładki **Releases** tego repozytorium (najnowsze wydanie), albo
   - z zakładki **Actions** (artefakt `cctv-fabric` przy każdym buildzie), albo
   - zbuduj go sam: `./gradlew build`. Jar pojawi się w `build/libs/`.
2. Wrzuć go do katalogu `mods/` serwera, obok Fabric API.
3. Uruchom serwer. W logu zobaczysz `CCTV web server listening on http://0.0.0.0:8100/`.
4. Otwórz port **8100/TCP** w firewallu lub u hostingu. Port zmienisz w konfiguracji.

Przy pierwszym starcie mod pobiera z oficjalnych serwerów Mojang `client.jar` tej samej wersji gry
(ok. 30 MB, jednorazowo, trafia do `config/cctv/assets/`). Tak samo robią launchery i mapy typu
BlueMap. Z pliku brane są tylko tekstury i modele bloków dla przeglądarki. **Graczom nic nie jest
wysyłane.** Jeśli serwer nie ma internetu, wrzuć `client.jar` ręcznie do `config/cctv/assets/`.
Możesz też wyłączyć pobieranie (`downloadClientAssets: false`); podgląd działa wtedy na zwykłych
kolorach.

## Komendy

Wymagają uprawnień operatora (poziom 2). `list` i `url` może wpisać każdy.

| Komenda | Opis |
|---|---|
| `/cctv create <nazwa>` | Stawia kamerę tam, gdzie masz oczy, i kieruje ją tam, gdzie patrzysz |
| `/cctv create <nazwa> <x y z> [<yaw> <pitch>]` | Kamera w podanym miejscu |
| `/cctv move <nazwa> [<x y z> [<yaw> <pitch>]]` | Przenosi kamerę (domyślnie w twoje miejsce) |
| `/cctv aim <nazwa> [<x y z>]` | Kieruje kamerę na punkt (domyślnie na ciebie) |
| `/cctv fov <nazwa> <stopnie>` | Kąt widzenia (10–140°, domyślnie 70) |
| `/cctv range <nazwa> <bloki>` | Zasięg widzenia (16–`maxRange`, domyślnie 64) |
| `/cctv remove <nazwa>` | Usuwa kamerę |
| `/cctv list` | Lista kamer z klikalnymi linkami |
| `/cctv url [<nazwa>]` | Link do podglądu |
| `/cctv info <nazwa>` | Szczegóły kamery |

Kamera jest w grze widoczna jako mały blok obserwatora (encja `block_display`, którą każdy klient
vanilla widzi). Wyłączysz to opcją `markers`. Działa też `execute in <wymiar> run cctv create ...`.

Kamera pokazuje tylko **załadowane chunki**, czyli to, co serwer i tak symuluje. Jeśli ma działać,
gdy nikogo nie ma w pobliżu, załaduj teren na stałe, np.
`/forceload add <x1> <z1> <x2> <z2>`.

## Podgląd w przeglądarce

- `http://IP-SERWERA:8100/` to lista kamer i **ściana monitorów** (wszystkie kamery naraz).
- `http://IP-SERWERA:8100/cam/<nazwa>` to jedna kamera.

Myszą możesz się rozejrzeć (przeciąganie), kółkiem przybliżyć, a podwójnym kliknięciem wrócić do
widoku kamery. Na pasku są przełączniki: nazwy graczy, podpisy mobów, tryb (kolor / czarno-biały /
noktowizor), efekt CCTV (skanlinie) i pełny ekran.

## Konfiguracja – `config/cctv/config.json`

| Klucz | Domyślnie | Opis |
|---|---|---|
| `bindAddress` | `0.0.0.0` | Adres serwera WWW |
| `port` | `8100` | Port serwera WWW |
| `accessToken` | `""` | Jeśli ustawisz, podgląd wymaga `?token=...` (zapamiętywany w ciasteczku). Operatorzy dostają link z tokenem w `/cctv url` |
| `publicUrl` | `""` | Adres do linków w czacie, np. `http://mc.example.com:8100` |
| `defaultFov` / `defaultRange` / `maxRange` | `70` / `64` / `160` | Ustawienia nowych kamer |
| `entityUpdateTicks` | `1` | Co ile ticków wysyłać encje (1 = 20×/s) |
| `sectionsPerTick` | `48` | Ile sekcji 16³ kamera może odczytać na tick przy ładowaniu |
| `rescanSeconds` | `5` | Pełne ponowne sprawdzenie obszaru co tyle sekund (zabezpieczenie) |
| `downloadClientAssets` | `true` | Pobieranie tekstur/modeli z `client.jar` od Mojang |
| `gzip` | `true` | Kompresja strumienia |
| `skins` | `true` | Skiny graczy (serwer pobiera je z API Mojang i trzyma w cache) |
| `markers` | `true` | Blok-znacznik kamery w świecie |
| `maxViewersPerCamera` | `16` | Limit widzów na kamerę |

Resource packi (`*.zip`) wrzucone do `config/cctv/resourcepacks/` nadpisują tekstury i modele bloków
w podglądzie, np. żeby zgadzały się z resource packiem serwera.

## Jak to działa

```
Serwer (tick, bez GPU)                        Przeglądarka (WebGL2)
────────────────────────                      ──────────────────────────────
/cctv create  ──► kamera (pozycja, kąt, fov)
widz się łączy ──► sekcje 16³ w stożku widzenia:    ──► mesher: modele bloków z client.jar,
                   id stanów bloków (paleta + RLE),      culling ścian, smooth lighting + AO
                   światło nieba/bloków, biomy           (algorytm Minecrafta), tinty biomów,
zmiana bloku (mixin) ──► "blocks" natychmiast            ciecze jak LiquidBlockRenderer
co tick ──► lista encji (pozycja, obrót, poza…) ──► interpolacja ruchu, modele mobów,
co 1 s ──► czas dnia, deszcz                          lightmapa dnia/nocy, niebo, chmury
```

- Dane płyną przez **Server-Sent Events** (zwykły HTTP, przechodzi przez proxy i nginx).
- Serwer czyta tylko **już załadowane** chunki i nigdy nie ładuje nowych.
- Koszt serwera na kamerę z widzami: jednorazowy odczyt kilkuset sekcji (rozłożony na ticki),
  lista encji w promieniu kamery co tick i kilka–kilkadziesiąt KB/s danych na widza (zależnie od liczby encji).
  Kamera bez widzów nic nie kosztuje (jej cache jest zwalniany po minucie).
- Obraz ma opóźnienie ok. 100–150 ms (bufor wygładzający ruch encji).

## API (do adaptacji na własną stronę)

Wszystkie endpointy obsługują CORS i `?token=` (jeśli ustawiono token).

| Endpoint | Zawartość |
|---|---|
| `GET /api/cameras` | Lista kamer (JSON) |
| `GET /api/cameras/{nazwa}/stream` | Strumień SSE, zdarzenia poniżej |
| `GET /assets/bundle.json` | Blockstates, modele i tekstury bloków (z client.jar) |
| `GET /assets/entities.json`, `/assets/entity/{ścieżka}.png` | Tekstury mobów |
| `GET /skin/{uuid}?name=` | Skin gracza (PNG, nagłówek `X-Skin-Model`) |

Zdarzenia strumienia:

- `init`: `{camera:{name,dimension,x,y,z,yaw,pitch,fov,range}, sections, biomes:{id:{t,d,w,g?,f?,m}}, entityTicks}`,
  po nim świat jest wysyłany od zera;
- `palette`: `{s:[{id, n:"minecraft:oak_stairs", s:"facing=north,…", c:mapColor, f:flagi, b:[[x0,y0,z0,x1,y1,z1]…], l:światło, lv:poziom cieczy}]}`;
- `section`: `{x,y,z, p:[id…], r:RLE, sl:RLE światła nieba, bl:RLE światła bloków, bp:[biomy], bi:indeksy 4³}`,
  gdzie RLE to base64 par varintów `(długość, wartość)` w kolejności YZX;
- `blocks`: `{b:[[x,y,z,id]…]}`, czyli natychmiastowe zmiany bloków;
- `entities`: `{t:tick, e:[{id,type,x,y,z,yaw,pitch,body,head,w,h,name?,uuid?,pose?,sneak?,baby?,hurt?,swing?,hand?,armor?,item?}]}`;
- `env`: `{time, rain, thunder}`;
- `ready`: cały widoczny obszar został wysłany;
- `removed`: kamera usunięta.

## Rozwój

- Nowe wydanie: podbij `version` w `gradle.properties`, dodaj opis w `docs/release-notes/v<wersja>.md`
  i wypchnij tag `v<wersja>`. Workflow `release` zbuduje mod i opublikuje release z jarem.

- Pliki strony są w `src/main/resources/web/` (zwykły JS, bez bundlera i bibliotek).
- Po uruchomieniu serwera z `-Dcctv.webDir=/ścieżka/do/src/main/resources/web` zmiany w plikach
  strony widać od razu po odświeżeniu, bez restartu.
- CI (`.github/workflows/build.yml`) buduje mod, uruchamia prawdziwy serwer 26.3 z modem i przez
  RCON stawia kamerę. Sprawdza strumień (sekcje, światło, encje 20×/s, natychmiastowe zmiany
  bloków) oraz pobranie assetów, a potem robi zrzut ekranu podglądu w Chromium (artefakt
  `server-test`).

## Ograniczenia

- Skrzynie mają prawdziwy model. Pozostałe bloki rysowane w grze jako „block entity” (tabliczki,
  łóżka, banery, głowy) są pokazane jako uproszczone bryły w kolorze bloku.
- Moby mają modele z gry: gracz, zombie, husk, drowned, szkielety, creeper, pająki, krowa, mooshroom,
  świnia, owca, kurczak, osadnik, wędrowny handlarz, enderman, wilk i slime. Pozostałe mają
  uproszczone modele.
- Przedmioty w rękach są płaskimi sprite'ami (bez dokładnych pozycji z modeli przedmiotów).
  Deszcz, cząsteczki i animacje otwierania skrzyń nie są rysowane.
- Tekstury z `client.jar` nie są częścią tego repozytorium. Mod pobiera je z serwerów Mojang na
  serwerze, który ma grę.

## Licencja

MIT – zobacz [LICENSE](LICENSE). Minecraft jest znakiem towarowym Mojang/Microsoft. Mod nie jest
powiązany z Mojang.
