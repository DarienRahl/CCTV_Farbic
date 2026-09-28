# CCTV – kamery na żywo dla serwera Minecraft (Fabric 26.3)

Mod **tylko po stronie serwera**. Stawiasz komendą „kamerę” w świecie, a jej obraz na żywo
oglądasz w przeglądarce: gracze, moby, otwierane drzwi i stawiane bloki widać od razu.

- **Gracze nie potrzebują moda.** Wchodzą na serwer zwykłym klientem vanilla.
- **Bez dodatkowego konta Minecraft i bez bota.** Nikt nie musi być zalogowany, żeby kamera działała.
- **Serwer nie renderuje obrazu i nie potrzebuje GPU.** Wysyła tylko lekkie dane: bloki, światło,
  biomy i pozycje encji 20 razy na sekundę. Całe renderowanie robi przeglądarka (WebGL2).
- **Wygląd 1:1 jak w Minecrafcie 26.3.** Siatki bloków powstają tym samym algorytmem co w kliencie
  (warianty modeli, przesunięcia roślin, *smooth lighting* z AO, cieniowanie ścian, mieszanie kolorów
  biomów 5×5, ciecze). Światło, mgła, niebo, słońce, księżyc z fazami, gwiazdy, wschody i zachody,
  chmury, deszcz, śnieg, burze z piorunami i błyskami, niebo Endu i **rozbłyski w Endzie** są liczone
  z tych samych atrybutów środowiska co w grze.
- **Wszystkie moby z prawdziwymi modelami.** Geometria modeli jest brana z `client.jar` (happy ghast,
  konie z umaszczeniem i znaczeniami, wilki, koty, osadnicy z profesjami, warianty zimne/ciepłe…),
  razem z siodłami, zbrojami, obrożami, wełną, uprzężami i świecącymi oczami. Gracze mają swoje skiny.
- **Ogromny zasięg.** Kamera widzi też teren z niezaładowanych chunków (czytany z plików regionów
  poza głównym wątkiem, podobnie jak robi to Bobby), do 1024 bloków.
- **Shadery i własne niebo.** Opcjonalny tryb „shaderów” (cienie od słońca, falujące rośliny, woda
  z odbiciami, poświata, promienie słońca), własne efekty końcowe GLSL i skyboxy, z domyślnymi
  ustawieniami dla wszystkich widzów ustawianymi przez admina.

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
BlueMap. Z pliku brane są tylko tekstury, modele bloków i geometria modeli mobów dla przeglądarki
(geometria jest zapisywana w `entity-models-<wersja>.json.gz`, żeby nie czytać jej przy każdym
starcie). **Graczom nic nie jest wysyłane.** Jeśli serwer nie ma internetu, wrzuć `client.jar` ręcznie do `config/cctv/assets/`.
Możesz też wyłączyć pobieranie (`downloadClientAssets: false`); podgląd działa wtedy na zwykłych
kolorach.

## Komendy

Wymagają uprawnień operatora (poziom 2). `list` i `url` może wpisać każdy.

| Komenda | Opis |
|---|---|
| `/cctv create <nazwa>` | Stawia kamerę na wysokości twoich oczu i kieruje ją tam, gdzie patrzysz |
| `/cctv create <nazwa> <x y z> [<yaw> <pitch>]` | Kamera w podanym miejscu (`~ ~ ~` = wysokość oczu, `^ ^ ^` liczone od oczu) |
| `/cctv move <nazwa> [<x y z> [<yaw> <pitch>]]` | Przenosi kamerę (domyślnie w twoje miejsce) |
| `/cctv aim <nazwa> [<x y z>]` | Kieruje kamerę na punkt (domyślnie na ciebie) |
| `/cctv fov <nazwa> <stopnie>` | Kąt widzenia (10–140°, domyślnie 70) |
| `/cctv range <nazwa> <bloki>` | Zasięg widzenia (16–`maxRange`, domyślnie 96) |
| `/cctv remove <nazwa>` | Usuwa kamerę |
| `/cctv list` | Lista kamer z klikalnymi linkami |
| `/cctv url [<nazwa>]` | Link do podglądu |
| `/cctv info <nazwa>` | Szczegóły kamery |
| `/cctv reload` | Wczytuje ponownie ustawienia podglądu (`viewer`), shadery i skyboxy |

Kamera jest w grze widoczna jako mały blok obserwatora (encja `block_display`, którą każdy klient
vanilla widzi). Wyłączysz to opcją `markers`. Działa też `execute in <wymiar> run cctv create ...`.

Na żywo (moby, zmiany bloków, światło) kamera pokazuje **załadowane chunki**. Dalszy teren
(`farTerrain`) jest czytany z zapisanych plików świata, bez ładowania chunków, i odświeżany co
jakiś czas. Jeśli kamera ma pokazywać ruch, gdy nikogo nie ma w pobliżu, załaduj teren na stałe, np.
`/forceload add <x1> <z1> <x2> <z2>`.

## Podgląd w przeglądarce

- `http://IP-SERWERA:8100/` to lista kamer i **ściana monitorów** (wszystkie kamery naraz).
- `http://IP-SERWERA:8100/cam/<nazwa>` to jedna kamera.

Myszą możesz się rozejrzeć (przeciąganie), kółkiem przybliżyć, a podwójnym kliknięciem wrócić do
widoku kamery. W **⚙ Ustawieniach** są: grafika (vanilla / shadery) i jakość shaderów, efekt końcowy
(własny shader), niebo (skybox), chmury, tryb (kolor / czarno-biały / noktowizor), rozdzielczość
renderowania (dla słabych GPU), nazwy graczy, podpisy mobów i efekt CCTV. Wybór widza jest
zapamiętywany w przeglądarce. Nazwy i podpisy są pokazywane tylko dla encji, które naprawdę widać
(nie przez ściany).

### Shadery, efekty i skyboxy

- **Grafika „Shadery”** działa w każdej przeglądarce z WebGL2: cienie od słońca i księżyca, falujące
  liście i trawa, fale i odbicia na wodzie, poświata jasnych bloków i promienie słońca. Jakość
  (niska–ultra) zmienia rozdzielczość i zasięg cieni.
- **Efekty końcowe**: pliki `config/cctv/shaders/<nazwa>.glsl` z funkcją `vec4 postProcess(vec2 uv)`
  (dostępne `uScene`, `uDepth`, `uResolution`, `uTime`, `uDaylight`, `uRain`, `linearDepth(uv)`).
  Przykłady `sepia.glsl` i `security-camera.glsl` są kopiowane przy pierwszym starcie.
- **Skyboxy**: folder `config/cctv/skyboxes/<nazwa>/` z sześcioma ścianami `px nx py ny pz nz`
  (png/jpg/webp) albo jedna panorama `config/cctv/skyboxes/<nazwa>.jpg`, opcjonalnie
  `<nazwa>.json` z `brightness`, `followDaylight`, `rotateWithSun`, `showSun`, `showClouds`
  (szczegóły w `config/cctv/skyboxes/README.txt`).
- **Domyślnie dla wszystkich**: sekcja `viewer` w `config.json` (np.
  `"viewer": {"graphics": "shaders", "skyboxes": {"minecraft:overworld": "zachod"}, "postShader": "sepia"}`),
  potem `/cctv reload`. `lockSettings: true` blokuje zmiany po stronie widzów.

## Konfiguracja – `config/cctv/config.json`

| Klucz | Domyślnie | Opis |
|---|---|---|
| `bindAddress` | `0.0.0.0` | Adres serwera WWW |
| `port` | `8100` | Port serwera WWW |
| `accessToken` | `""` | Jeśli ustawisz, podgląd wymaga `?token=...` (zapamiętywany w ciasteczku). Operatorzy dostają link z tokenem w `/cctv url` |
| `publicUrl` | `""` | Adres do linków w czacie, np. `http://mc.example.com:8100` |
| `defaultFov` / `defaultRange` / `maxRange` | `70` / `96` / `512` | Ustawienia nowych kamer (`maxRange` do 1024) |
| `farTerrain` | `true` | Teren z niezaładowanych chunków czytany z plików regionów (daleki zasięg) |
| `entityRange` | `128` | Do jakiej odległości wysyłać encje |
| `entityUpdateTicks` | `1` | Co ile ticków wysyłać encje (1 = 20×/s) |
| `sectionsPerTick` | `96` | Ile sekcji 16³ kamera może skopiować na tick przy ładowaniu |
| `workerThreads` | połowa rdzeni (1–4) | Wątki, które dekodują sekcje i czytają pliki świata poza głównym wątkiem |
| `rescanSeconds` | `5` | Pełne ponowne sprawdzenie obszaru co tyle sekund (zabezpieczenie) |
| `downloadClientAssets` | `true` | Pobieranie tekstur/modeli z `client.jar` od Mojang |
| `gzip` | `true` | Kompresja strumienia |
| `skins` | `true` | Skiny graczy (serwer pobiera je z API Mojang i trzyma w cache) |
| `markers` | `true` | Blok-znacznik kamery w świecie |
| `maxViewersPerCamera` | `16` | Limit widzów na kamerę |
| `viewer` | | Domyślne ustawienia podglądu: `graphics` (`vanilla`/`shaders`), `shaderQuality` (`low`…`ultra`), `postShader`, `skyboxes` (wymiar → nazwa), `clouds` (`fancy`/`fast`/`off`), `labels`, `mobLabels`, `mode` (`color`/`mono`/`night`), `cctvEffect`, `lockSettings` |

Resource packi (`*.zip`) wrzucone do `config/cctv/resourcepacks/` nadpisują tekstury i modele bloków
w podglądzie, np. żeby zgadzały się z resource packiem serwera.

## Jak to działa

```
Serwer (bez GPU)                                     Przeglądarka (WebGL2)
────────────────────────                             ──────────────────────────────
główny wątek: kopia sekcji (paleta, światło) ──┐
wątki robocze: dekodowanie, JSON, pliki regionów ├─► Web Workery: siatki sekcji jak SectionCompiler
zmiana bloku (mixin) ──► "blocks" natychmiast   │     (modele z client.jar, AO, biomy, ciecze)
co tick ──► encje (pozycja, animacja chodu,     └─► GPU: regiony sekcji, lightmapa 26.3, mgła,
            warianty, wyposażenie…)                   niebo, chmury, pogoda, End, modele mobów
co 5 ticków ──► atrybuty środowiska w kamerze
             (niebo, mgła, światło, słońce, deszcz, rozbłyski Endu)
```

- Dane płyną przez **Server-Sent Events** (zwykły HTTP, przechodzi przez proxy i nginx).
- Serwer nigdy nie ładuje chunków: czyta załadowane, a dalsze z zapisanych plików (wątek IO serwera
  + wątki robocze moda). Główny wątek tylko kopiuje dane sekcji; dekodowanie, kompresja i JSON
  dzieją się obok. Zakopane sekcje daleko pod powierzchnią i puste powietrze nie są wysyłane.
- Koszt serwera na kamerę z widzami: jednorazowa kopia sekcji (rozłożona na ticki),
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
| `GET /assets/models.json` | Geometria modeli mobów (warstwy z `LayerDefinitions`) |
| `GET /assets/entities.json`, `/assets/entity/{ścieżka}.png` | Tekstury mobów |
| `GET /assets/painting/{nazwa}.png` | Obrazy |
| `GET /api/viewer` | Domyślne ustawienia podglądu, lista shaderów i skyboxów |
| `GET /custom/shaders/{nazwa}.glsl`, `/custom/skyboxes/...` | Pliki shaderów i skyboxów z `config/cctv` |
| `GET /skin/{uuid}?name=` | Skin gracza (PNG, nagłówek `X-Skin-Model`) |

Zdarzenia strumienia:

- `init`: `{camera:{name,dimension,x,y,z,yaw,pitch,fov,range}, sections, biomes:{id:{t,d,w,g?,f?,m}}, entityTicks,
  dim:{id,skybox,cardinal,hasSky,ambient,endFlashes,minY,height,horizon,zoomSeed}}`, po nim świat jest wysyłany od zera;
- `progress`: `{d, t}` postęp wczytywania;
- `palette`: `{s:[{id, n:"minecraft:oak_stairs", s:"facing=north,…", c:mapColor, f:flagi, b:[[x0,y0,z0,x1,y1,z1]…], l:światło, lv:poziom cieczy}]}`;
- `section`: `{x,y,z, p:[id…], r:RLE, sl:RLE światła nieba, bl:RLE światła bloków, bp:[biomy], bi:indeksy 4³}`,
  gdzie RLE to base64 par varintów `(długość, wartość)` w kolejności YZX;
- `blocks`: `{b:[[x,y,z,id]…]}`, czyli natychmiastowe zmiany bloków;
- `entities`: `{t:tick, e:[{id,type,x,y,z,yaw,pitch,body,head,w,h,age,walk,walkSpeed,scale?,name?,uuid?,pose?,sneak?,baby?,
  hurt?,dead?,swing?,hand?,offhand?,saddle?,bodyArmor?,armor?,item?,seed?, d:{variant?, markings?, villager?, color?, …}}]}`;
- `env`: atrybuty środowiska w kamerze: `{time, clock, gt, rain, thunder, sky, fog, sunrise, cloud, cloudHeight, sunAngle,
  moonAngle, starAngle, stars, moonPhase, skyLight, skyFactor, ambient, blockTint, fogStart, fogEnd, skyFogEnd, …, flash?}`;
- `weather`: kolumny deszczu/śniegu wokół kamery `{x, z, size, h:[wysokości], p:"rsn…"}`;
- `ready`: cały widoczny obszar został wysłany;
- `removed`: kamera usunięta.

## Rozwój

- Nowe wydanie: podbij `version` w `gradle.properties`, dodaj opis w `docs/release-notes/v<wersja>.md`
  i wypchnij tag `v<wersja>` albo uruchom ręcznie workflow `release` w zakładce Actions.
  Workflow zbuduje mod, utworzy tag i opublikuje release z jarem.

- Pliki strony są w `src/main/resources/web/` (zwykły JS, bez bundlera i bibliotek).
- Po uruchomieniu serwera z `-Dcctv.webDir=/ścieżka/do/src/main/resources/web` zmiany w plikach
  strony widać od razu po odświeżeniu, bez restartu.
- CI (`.github/workflows/build.yml`) buduje mod, uruchamia prawdziwy serwer 26.3 z modem i przez
  RCON stawia kamerę. Sprawdza strumień (sekcje, światło, encje 20×/s, natychmiastowe zmiany
  bloków) oraz pobranie assetów, a potem robi zrzut ekranu podglądu w Chromium (artefakt
  `server-test`).

## Ograniczenia

- Animacje mobów oparte w grze na klatkach kluczowych (np. sniffer, warden, żaba, pancernik) są
  uproszczone: głowa i nogi się ruszają, ale bez pełnych sekwencji. Wzory na banerach i tarczach
  nie są rysowane (tylko kolor bazowy).
- Cząsteczki, dźwięki i animacje otwierania skrzyń nie są rysowane.
- Teren z niezaładowanych chunków pokazuje stan z ostatniego zapisu świata.
- Tekstury i modele z `client.jar` nie są częścią tego repozytorium. Mod pobiera je z serwerów Mojang
  na serwerze, który ma grę.

## Licencja

MIT – zobacz [LICENSE](LICENSE). Minecraft jest znakiem towarowym Mojang/Microsoft. Mod nie jest
powiązany z Mojang.
