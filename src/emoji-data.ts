/**
 * Compact emoji data set for the picker (src/emoji-picker.tsx), loaded lazily via dynamic import.
 * One line per emoji: `emoji|english name|deutscher Name|extra keywords` (keywords in both languages, optional).
 * Flags and skin tone variants are left out on purpose (one emoji per concept).
 */
const RAW: Record<string, string> = {
  smileys: `
😀|grinning face|grinsendes Gesicht|happy froh
😃|grinning face with big eyes|grinsendes Gesicht mit großen Augen|happy
😄|grinning face with smiling eyes|grinsendes Gesicht mit lachenden Augen|happy
😁|beaming face with smiling eyes|strahlendes Gesicht|grin
😆|grinning squinting face|grinsen mit zusammengekniffenen Augen|laugh lachen
😅|grinning face with sweat|grinsendes Gesicht mit Schweißtropfen|relief
🤣|rolling on the floor laughing|auf dem Boden rollen vor Lachen|rofl lol
😂|face with tears of joy|Gesicht mit Freudentränen|laugh lachen lol
🙂|slightly smiling face|leicht lächelndes Gesicht|smile lächeln
🙃|upside-down face|umgedrehtes Gesicht|silly
😉|winking face|zwinkerndes Gesicht|wink zwinkern
😊|smiling face with smiling eyes|lächelndes Gesicht mit lachenden Augen|blush
😇|smiling face with halo|lächelndes Gesicht mit Heiligenschein|angel Engel
🥰|smiling face with hearts|lächelndes Gesicht mit Herzen|love liebe
😍|smiling face with heart-eyes|lächelndes Gesicht mit Herzaugen|love liebe verliebt
🤩|star-struck|Gesicht mit Sternenaugen|wow
😘|face blowing a kiss|Kuss zuwerfendes Gesicht|kiss Kuss
😗|kissing face|küssendes Gesicht|kiss
😋|face savoring food|Gesicht mit Zunge, lecker|yum lecker
😛|face with tongue|Gesicht mit herausgestreckter Zunge|tongue
😜|winking face with tongue|zwinkerndes Gesicht mit Zunge|crazy verrückt
🤪|zany face|verrücktes Gesicht|crazy
🤑|money-mouth face|Gesicht mit Dollarzeichen|money Geld reich
🤗|smiling face with open hands|lächelndes Gesicht mit offenen Händen|hug umarmen
🤭|face with hand over mouth|Gesicht mit Hand vor dem Mund|oops kichern
🤫|shushing face|Gesicht, das Psst macht|quiet secret Geheimnis leise
🤔|thinking face|nachdenkliches Gesicht|think denken
🤨|face with raised eyebrow|Gesicht mit hochgezogener Augenbraue|skeptical
😐|neutral face|neutrales Gesicht|
😶|face without mouth|Gesicht ohne Mund|speechless sprachlos
😏|smirking face|selbstgefällig grinsendes Gesicht|smirk
😒|unamused face|genervtes Gesicht|
🙄|face with rolling eyes|Gesicht mit rollenden Augen|eyeroll
😬|grimacing face|Gesicht mit Grimasse|awkward
😌|relieved face|erleichtertes Gesicht|calm
😔|pensive face|nachdenkliches trauriges Gesicht|sad traurig
😪|sleepy face|schläfriges Gesicht|tired müde
😴|sleeping face|schlafendes Gesicht|sleep schlafen zzz
😷|face with medical mask|Gesicht mit Mundschutz|sick krank
🤒|face with thermometer|Gesicht mit Fieberthermometer|ill fieber
🤕|face with head-bandage|Gesicht mit Kopfverband|hurt
🤢|nauseated face|Gesicht mit Übelkeit|sick ekel
🤧|sneezing face|niesendes Gesicht|cold erkältet
🥵|hot face|überhitztes Gesicht|heiß
🥶|cold face|frierendes Gesicht|kalt
🥴|woozy face|benommenes Gesicht|dizzy
🤯|exploding head|explodierender Kopf|mind blown
🤠|cowboy hat face|Gesicht mit Cowboyhut|cowboy
🥳|partying face|feierndes Gesicht|party feiern geburtstag birthday
😎|smiling face with sunglasses|lächelndes Gesicht mit Sonnenbrille|cool
🤓|nerd face|Nerd-Gesicht|geek
🧐|face with monocle|Gesicht mit Monokel|
😕|confused face|verwirrtes Gesicht|
😟|worried face|besorgtes Gesicht|
🙁|slightly frowning face|leicht Stirn runzelndes Gesicht|
😮|face with open mouth|Gesicht mit offenem Mund|surprised
😲|astonished face|verblüfftes Gesicht|
😳|flushed face|errötetes Gesicht|embarrassed
🥺|pleading face|bettelndes Gesicht|please bitte
😨|fearful face|ängstliches Gesicht|
😥|sad but relieved face|trauriges aber erleichtertes Gesicht|
😢|crying face|weinendes Gesicht|cry weinen traurig
😭|loudly crying face|laut weinendes Gesicht|sob
😱|face screaming in fear|vor Angst schreiendes Gesicht|scream
😞|disappointed face|enttäuschtes Gesicht|
😩|weary face|müdes Gesicht|
🥱|yawning face|gähnendes Gesicht|yawn gähnen
😤|face with steam from nose|Gesicht mit Dampf aus der Nase|triumph
😡|enraged face|wütendes Gesicht|angry wütend
😠|angry face|verärgertes Gesicht|mad
🤬|face with symbols on mouth|Gesicht mit Symbolen über dem Mund|swear fluchen
😈|smiling face with horns|lächelndes Gesicht mit Hörnern|devil Teufel
💀|skull|Totenkopf|death tod
💩|pile of poo|Kothaufen|poop
🤡|clown face|Clown-Gesicht|
👻|ghost|Geist|halloween
👽|alien|Außerirdischer|ufo
🤖|robot|Roboter|
😺|grinning cat|grinsende Katze|
😻|smiling cat with heart-eyes|lächelnde Katze mit Herzaugen|
🙈|see-no-evil monkey|Affe, der nichts sieht|monkey Affe
🙉|hear-no-evil monkey|Affe, der nichts hört|monkey Affe
🙊|speak-no-evil monkey|Affe, der nichts sagt|monkey Affe
💋|kiss mark|Kussmund|lips kuss
💌|love letter|Liebesbrief|mail post
💘|heart with arrow|Herz mit Pfeil|cupid amor
💝|heart with ribbon|Herz mit Schleife|gift geschenk
💖|sparkling heart|funkelndes Herz|
💗|growing heart|wachsendes Herz|
💓|beating heart|schlagendes Herz|
💞|revolving hearts|kreisende Herzen|
💕|two hearts|zwei Herzen|love liebe
💔|broken heart|gebrochenes Herz|
❤️|red heart|rotes Herz|love liebe
🧡|orange heart|oranges Herz|
💛|yellow heart|gelbes Herz|
💚|green heart|grünes Herz|
💙|blue heart|blaues Herz|
💜|purple heart|lila Herz|
🤎|brown heart|braunes Herz|
🖤|black heart|schwarzes Herz|
🤍|white heart|weißes Herz|
💯|hundred points|hundert Punkte|100
💥|collision|Zusammenstoß|boom
💫|dizzy|Schwindel|star
💦|sweat droplets|Schweißtropfen|water wasser
💤|zzz|Schlafen|sleep schlafen
`,
  people: `
👋|waving hand|winkende Hand|hello hallo wave
✋|raised hand|erhobene Hand|stop
👌|ok hand|OK-Zeichen|perfect
✌️|victory hand|Victory-Zeichen|peace frieden
🤞|crossed fingers|gekreuzte Finger|luck glück
🤟|love-you gesture|Ich-liebe-dich-Geste|
🤘|sign of the horns|Teufelsgruß|rock
👈|backhand index pointing left|nach links zeigender Zeigefinger|
👉|backhand index pointing right|nach rechts zeigender Zeigefinger|
👆|backhand index pointing up|nach oben zeigender Zeigefinger|
👇|backhand index pointing down|nach unten zeigender Zeigefinger|
👍|thumbs up|Daumen hoch|like gut yes ja
👎|thumbs down|Daumen runter|dislike schlecht no nein
✊|raised fist|erhobene Faust|
👊|oncoming fist|geballte Faust|punch
👏|clapping hands|klatschende Hände|applause beifall
🙌|raising hands|zwei erhobene Hände|hooray
🤝|handshake|Handschlag|deal
🙏|folded hands|zusammengelegte Hände|pray danke thanks beten
💅|nail polish|Nagellack|
🤳|selfie|Selfie|
💪|flexed biceps|angespannter Bizeps|strong stark muscle
🧠|brain|Gehirn|
👀|eyes|Augen|look
👅|tongue|Zunge|
👄|mouth|Mund|lips
👶|baby|Baby|kind child
🧒|child|Kind|
👦|boy|Junge|
👧|girl|Mädchen|
🧑|person|Person|
👨|man|Mann|
🧔|person with beard|Person mit Bart|
👩|woman|Frau|
🧓|older person|ältere Person|
👴|old man|alter Mann|opa grandpa
👵|old woman|alte Frau|oma grandma
🙋|person raising hand|Person mit erhobener Hand|
🤦|person facepalming|Person die Hand vor Stirn schlägt|facepalm
🤷|person shrugging|Schulterzucken|shrug
🧑‍⚕️|health worker|Arzt oder Ärztin|doctor nurse
🧑‍🎓|student|Student|
🧑‍🏫|teacher|Lehrer|
🧑‍🍳|cook|Koch|chef
🧑‍🔧|mechanic|Mechaniker|
🧑‍💻|technologist|Entwickler|developer
🧑‍🎨|artist|Künstler|
🧑‍🚀|astronaut|Astronaut|
🧑‍🚒|firefighter|Feuerwehrmann|
👮|police officer|Polizist|
🕵️|detective|Detektiv|
👷|construction worker|Bauarbeiter|
🤴|prince|Prinz|
👸|princess|Prinzessin|
🎅|santa claus|Weihnachtsmann|christmas weihnachten
🤶|mrs claus|Weihnachtsfrau|christmas
🦸|superhero|Superheld|
🧙|mage|Magier|wizard zauberer
🧚|fairy|Fee|
🧛|vampire|Vampir|
🧜|merperson|Meerjungfrau|mermaid
🧝|elf|Elf|
💆|person getting massage|Person bei der Massage|spa
💇|person getting haircut|Person beim Friseur|
🚶|person walking|Fußgänger|walk gehen
🏃|person running|rennende Person|run laufen
💃|woman dancing|tanzende Frau|dance tanzen
🕺|man dancing|tanzender Mann|dance tanzen
🧘|person in lotus position|Person im Lotossitz|yoga
👭|women holding hands|Händchen haltende Frauen|couple paar
👫|woman and man holding hands|Händchen haltendes Paar|couple paar
👬|men holding hands|Händchen haltende Männer|couple paar
💑|couple with heart|Paar mit Herz|love liebe
💏|kiss|Kuss|couple
👪|family|Familie|
👣|footprints|Fußabdrücke|
🧢|billed cap|Basecap|hat mütze
👑|crown|Krone|king queen könig
🎩|top hat|Zylinder|
🎓|graduation cap|Doktorhut|abschluss
👓|glasses|Brille|
🕶️|sunglasses|Sonnenbrille|
👔|necktie|Krawatte|
👕|t-shirt|T-Shirt|
👖|jeans|Jeans|
🧣|scarf|Schal|
🧤|gloves|Handschuhe|
🧥|coat|Mantel|
👗|dress|Kleid|
👙|bikini|Bikini|
👜|handbag|Handtasche|
👛|purse|Geldbörse|
🎒|backpack|Rucksack|school schule
👟|running shoe|Sportschuh|sneaker
👠|high-heeled shoe|Schuh mit hohem Absatz|
👢|boot|Stiefel|
💍|ring|Ring|wedding hochzeit
💄|lipstick|Lippenstift|
`,
  animals: `
🐶|dog face|Hundegesicht|hund
🐕|dog|Hund|
🐩|poodle|Pudel|
🐺|wolf|Wolf|
🦊|fox|Fuchs|
🦝|raccoon|Waschbär|
🐱|cat face|Katzengesicht|katze
🐈|cat|Katze|
🐈‍⬛|black cat|schwarze Katze|
🦁|lion|Löwe|
🐯|tiger face|Tigergesicht|tiger
🐴|horse face|Pferdegesicht|pferd
🦄|unicorn|Einhorn|
🦓|zebra|Zebra|
🦌|deer|Hirsch|
🐮|cow face|Kuhgesicht|kuh
🐷|pig face|Schweinegesicht|schwein
🐗|boar|Wildschwein|
🐑|ewe|Schaf|sheep
🐐|goat|Ziege|
🦙|llama|Lama|
🦒|giraffe|Giraffe|
🐘|elephant|Elefant|
🦏|rhinoceros|Nashorn|
🐭|mouse face|Mäusegesicht|maus
🐹|hamster|Hamster|
🐰|rabbit face|Hasengesicht|hase kaninchen bunny
🐿️|chipmunk|Streifenhörnchen|squirrel eichhörnchen
🦔|hedgehog|Igel|
🦇|bat|Fledermaus|
🐻|bear|Bär|
🐻‍❄️|polar bear|Eisbär|
🐨|koala|Koala|
🐼|panda|Panda|
🦥|sloth|Faultier|
🦘|kangaroo|Känguru|
🐾|paw prints|Pfotenabdrücke|pet haustier
🦃|turkey|Truthahn|
🐔|chicken|Huhn|
🐣|hatching chick|schlüpfendes Küken|
🐦|bird|Vogel|
🐧|penguin|Pinguin|
🕊️|dove|Taube|peace frieden
🦅|eagle|Adler|
🦆|duck|Ente|
🦢|swan|Schwan|
🦉|owl|Eule|
🦩|flamingo|Flamingo|
🦚|peacock|Pfau|
🦜|parrot|Papagei|
🐸|frog|Frosch|
🐊|crocodile|Krokodil|
🐢|turtle|Schildkröte|
🦎|lizard|Eidechse|
🐍|snake|Schlange|
🐲|dragon face|Drachengesicht|drache
🦖|t-rex|T-Rex|dinosaur dinosaurier
🐳|spouting whale|Wal mit Fontäne|
🐬|dolphin|Delfin|
🐟|fish|Fisch|
🐠|tropical fish|Tropenfisch|
🦈|shark|Hai|
🐙|octopus|Oktopus|
🐚|spiral shell|Muschel|
🐌|snail|Schnecke|
🦋|butterfly|Schmetterling|
🐛|bug|Raupe|
🐜|ant|Ameise|
🐝|honeybee|Honigbiene|bee biene
🐞|lady beetle|Marienkäfer|ladybug
🕷️|spider|Spinne|
🦂|scorpion|Skorpion|
💐|bouquet|Blumenstrauß|flowers blumen
🌸|cherry blossom|Kirschblüte|
🌹|rose|Rose|
🥀|wilted flower|verwelkte Blume|
🌺|hibiscus|Hibiskus|
🌻|sunflower|Sonnenblume|
🌼|blossom|Blüte|
🌷|tulip|Tulpe|
🌱|seedling|Setzling|plant pflanze
🪴|potted plant|Topfpflanze|
🌲|evergreen tree|Nadelbaum|tree baum tanne
🎄|christmas tree|Weihnachtsbaum|weihnachten
🌳|deciduous tree|Laubbaum|tree baum
🌴|palm tree|Palme|
🌵|cactus|Kaktus|
🍀|four leaf clover|vierblättriges Kleeblatt|luck glück
🍁|maple leaf|Ahornblatt|autumn herbst
🍂|fallen leaf|Herbstlaub|autumn herbst
🍄|mushroom|Pilz|
🌍|globe showing europe-africa|Globus Europa und Afrika|world welt erde earth
🌙|crescent moon|Mondsichel|night nacht
🌕|full moon|Vollmond|
⭐|star|Stern|
🌟|glowing star|glänzender Stern|
✨|sparkles|Funken|glitzer glitter
⚡|high voltage|Hochspannung|blitz lightning
🔥|fire|Feuer|hot
🌈|rainbow|Regenbogen|
☀️|sun|Sonne|
⛅|sun behind cloud|Sonne hinter Wolke|
☁️|cloud|Wolke|
🌧️|cloud with rain|Wolke mit Regen|rain regen
❄️|snowflake|Schneeflocke|snow schnee winter
⛄|snowman|Schneemann|
💧|droplet|Tropfen|water wasser
🌊|water wave|Welle|sea meer
`,
  food: `
🍏|green apple|grüner Apfel|
🍎|red apple|roter Apfel|apfel
🍐|pear|Birne|
🍊|tangerine|Mandarine|orange
🍋|lemon|Zitrone|
🍌|banana|Banane|
🍉|watermelon|Wassermelone|
🍇|grapes|Trauben|
🍓|strawberry|Erdbeere|
🫐|blueberries|Blaubeeren|
🍒|cherries|Kirschen|
🍑|peach|Pfirsich|
🥭|mango|Mango|
🍍|pineapple|Ananas|
🥥|coconut|Kokosnuss|
🥝|kiwi fruit|Kiwi|
🍅|tomato|Tomate|
🍆|eggplant|Aubergine|
🥑|avocado|Avocado|
🥦|broccoli|Brokkoli|
🥒|cucumber|Gurke|
🌶️|hot pepper|Peperoni|chili scharf
🌽|ear of corn|Maiskolben|
🥕|carrot|Karotte|möhre
🧄|garlic|Knoblauch|
🧅|onion|Zwiebel|
🥔|potato|Kartoffel|
🥐|croissant|Croissant|
🥖|baguette bread|Baguette|brot
🍞|bread|Brot|
🥨|pretzel|Brezel|
🧀|cheese wedge|Käse|
🥚|egg|Ei|
🍳|cooking|Spiegelei in der Pfanne|egg frühstück breakfast
🥞|pancakes|Pfannkuchen|
🧇|waffle|Waffel|
🥓|bacon|Speck|
🥩|cut of meat|Fleisch|steak
🍗|poultry leg|Hähnchenkeule|chicken
🌭|hot dog|Hotdog|
🍔|hamburger|Hamburger|burger
🍟|french fries|Pommes|fries
🍕|pizza|Pizza|
🥪|sandwich|Sandwich|
🌮|taco|Taco|
🌯|burrito|Burrito|
🥗|green salad|Salat|
🍝|spaghetti|Spaghetti|pasta nudeln
🍜|steaming bowl|Schüssel mit Dampf|ramen suppe soup
🍲|pot of food|Eintopf|
🍛|curry rice|Curry mit Reis|
🍣|sushi|Sushi|
🍱|bento box|Bento-Box|
🥟|dumpling|Teigtasche|
🍤|fried shrimp|Frittierte Garnele|
🍙|rice ball|Reisball|
🍚|cooked rice|Reis|
🍦|soft ice cream|Softeis|ice cream eis
🍨|ice cream|Eiscreme|eis
🍩|doughnut|Donut|
🍪|cookie|Keks|plätzchen
🎂|birthday cake|Geburtstagskuchen|cake torte party
🍰|shortcake|Kuchenstück|cake kuchen
🧁|cupcake|Cupcake|muffin
🥧|pie|Pastete|kuchen
🍫|chocolate bar|Schokolade|
🍬|candy|Bonbon|süßigkeiten sweets
🍭|lollipop|Lutscher|
🍮|custard|Pudding|
🍯|honey pot|Honigtopf|honig
🍼|baby bottle|Babyflasche|
🥛|glass of milk|Glas Milch|
☕|hot beverage|Heißgetränk|coffee kaffee tea tee
🍵|teacup without handle|Teetasse|tea tee
🍾|bottle with popping cork|Flasche mit knallendem Korken|champagne sekt
🍷|wine glass|Weinglas|wein
🍸|cocktail glass|Cocktailglas|
🍹|tropical drink|Tropischer Drink|cocktail
🍺|beer mug|Bierkrug|bier
🍻|clinking beer mugs|anstoßende Bierkrüge|prost cheers
🥂|clinking glasses|anstoßende Gläser|prost cheers sekt
🥃|tumbler glass|Tumbler|whisky
🥤|cup with straw|Becher mit Strohhalm|
🧃|beverage box|Trinkpäckchen|juice saft
🍽️|fork and knife with plate|Teller mit Messer und Gabel|dinner essen
🍴|fork and knife|Messer und Gabel|restaurant
🥄|spoon|Löffel|
`,
  activities: `
⚽|soccer ball|Fußball|football
🏀|basketball|Basketball|
🏈|american football|American Football|
⚾|baseball|Baseball|
🎾|tennis|Tennis|
🏐|volleyball|Volleyball|
🎱|pool 8 ball|Billard|
🏓|ping pong|Tischtennis|
🏸|badminton|Badminton|
⛳|flag in hole|Golf|
🏹|bow and arrow|Pfeil und Bogen|
🎣|fishing pole|Angel|angeln
🥊|boxing glove|Boxhandschuh|
⛸️|ice skate|Schlittschuh|
🎿|skis|Ski|
🏂|snowboarder|Snowboarder|
🏋️|person lifting weights|Gewichtheber|gym fitness
🚴|person biking|Radfahrer|bike fahrrad
🏊|person swimming|Schwimmer|schwimmen
🧗|person climbing|Kletterer|klettern
🏆|trophy|Pokal|win gewinn
🥇|1st place medal|Goldmedaille|gold
🥈|2nd place medal|Silbermedaille|
🥉|3rd place medal|Bronzemedaille|
🏅|sports medal|Sportmedaille|
🎫|ticket|Eintrittskarte|
🎪|circus tent|Zirkuszelt|
🎭|performing arts|Theater|masks masken
🎨|artist palette|Malpalette|art kunst
🎬|clapper board|Filmklappe|movie film
🎤|microphone|Mikrofon|sing singen karaoke
🎧|headphone|Kopfhörer|music musik
🎹|musical keyboard|Keyboard|piano klavier
🥁|drum|Trommel|
🎷|saxophone|Saxophon|
🎸|guitar|Gitarre|
🎺|trumpet|Trompete|
🎻|violin|Geige|
🎲|game die|Würfel|dice spiel game
♟️|chess pawn|Schachfigur|schach
🎯|direct hit|Volltreffer|dart ziel target
🎳|bowling|Bowling|
🎮|video game|Videospiel|controller gaming
🧩|puzzle piece|Puzzleteil|
🧸|teddy bear|Teddybär|
🪁|kite|Drachen|
🎉|party popper|Konfetti-Kracher|party celebrate feiern
🎊|confetti ball|Konfettiball|party
🎈|balloon|Luftballon|party geburtstag birthday
🎁|wrapped gift|Geschenk|present gift
🎀|ribbon|Schleife|
🎆|fireworks|Feuerwerk|silvester new year
🎇|sparkler|Wunderkerze|
🧨|firecracker|Böller|
🎃|jack-o-lantern|Kürbislaterne|halloween
🪅|piñata|Piñata|
`,
  travel: `
🚗|automobile|Auto|car
🚕|taxi|Taxi|
🚙|sport utility vehicle|SUV|
🚌|bus|Bus|
🏎️|racing car|Rennwagen|
🚓|police car|Polizeiauto|
🚑|ambulance|Krankenwagen|
🚒|fire engine|Feuerwehrauto|
🚚|delivery truck|Lieferwagen|
🚜|tractor|Traktor|
🛵|motor scooter|Motorroller|
🏍️|motorcycle|Motorrad|
🚲|bicycle|Fahrrad|bike
🛴|kick scooter|Tretroller|
🛹|skateboard|Skateboard|
🚂|locomotive|Lokomotive|
🚆|train|Zug|bahn
🚇|metro|U-Bahn|
🚊|tram|Straßenbahn|
🚁|helicopter|Hubschrauber|
✈️|airplane|Flugzeug|flight flug
🚀|rocket|Rakete|
🛸|flying saucer|Fliegende Untertasse|ufo
⛵|sailboat|Segelboot|
🚤|speedboat|Schnellboot|
🛳️|passenger ship|Passagierschiff|cruise kreuzfahrt
⚓|anchor|Anker|
⛽|fuel pump|Zapfsäule|tanken
🗺️|world map|Weltkarte|
🗽|statue of liberty|Freiheitsstatue|
🗼|tokyo tower|Tokyo Tower|
🏰|castle|Schloss|burg
🎡|ferris wheel|Riesenrad|
🎢|roller coaster|Achterbahn|
⛲|fountain|Brunnen|
⛱️|umbrella on ground|Sonnenschirm|beach strand
🏖️|beach with umbrella|Strand mit Sonnenschirm|urlaub vacation
🏝️|desert island|Insel|
🏔️|snow-capped mountain|Schneebedeckter Berg|
⛰️|mountain|Berg|
🌋|volcano|Vulkan|
🏕️|camping|Camping|zelt tent
⛺|tent|Zelt|
🏠|house|Haus|home zuhause
🏡|house with garden|Haus mit Garten|
🏢|office building|Bürogebäude|
🏥|hospital|Krankenhaus|
🏦|bank|Bank|
🏨|hotel|Hotel|
🏫|school|Schule|
⛪|church|Kirche|
🌃|night with stars|Sternennacht|
🌇|sunset|Sonnenuntergang|
🌅|sunrise|Sonnenaufgang|
🧳|luggage|Gepäck|koffer suitcase
⌛|hourglass done|Sanduhr|
⏰|alarm clock|Wecker|
`,
  objects: `
⌚|watch|Armbanduhr|uhr
📱|mobile phone|Handy|smartphone telefon
💻|laptop|Laptop|computer
⌨️|keyboard|Tastatur|
🖥️|desktop computer|Desktop-Computer|
🖨️|printer|Drucker|
💾|floppy disk|Diskette|save speichern
💿|optical disk|CD|
📷|camera|Kamera|foto photo
📹|video camera|Videokamera|
🎥|movie camera|Filmkamera|
📺|television|Fernseher|tv
📻|radio|Radio|
📞|telephone receiver|Telefonhörer|
🔋|battery|Batterie|
🔌|electric plug|Stecker|
💡|light bulb|Glühbirne|idea idee
🔦|flashlight|Taschenlampe|
🕯️|candle|Kerze|
💸|money with wings|Geld mit Flügeln|
💵|dollar banknote|Dollarschein|money geld
💶|euro banknote|Euroschein|money geld
💰|money bag|Geldsack|
💳|credit card|Kreditkarte|bank
💎|gem stone|Edelstein|diamond diamant
🔧|wrench|Schraubenschlüssel|werkzeug tool
🔨|hammer|Hammer|
🛠️|hammer and wrench|Hammer und Schraubenschlüssel|
🔩|nut and bolt|Schraube und Mutter|
⚙️|gear|Zahnrad|settings einstellungen
🧰|toolbox|Werkzeugkasten|
🧲|magnet|Magnet|
🔪|kitchen knife|Küchenmesser|
🛡️|shield|Schild|
🔮|crystal ball|Kristallkugel|
🔭|telescope|Teleskop|
🔬|microscope|Mikroskop|
🩹|adhesive bandage|Pflaster|
🩺|stethoscope|Stethoskop|
💊|pill|Tablette|medicine medizin
💉|syringe|Spritze|
🧬|dna|DNA|
🧪|test tube|Reagenzglas|
🌡️|thermometer|Thermometer|
🧹|broom|Besen|
🧺|basket|Korb|
🧻|roll of paper|Toilettenpapier|
🚽|toilet|Toilette|
🚿|shower|Dusche|
🛁|bathtub|Badewanne|
🧼|soap|Seife|
🧽|sponge|Schwamm|
🛒|shopping cart|Einkaufswagen|einkaufen shopping
🚪|door|Tür|
🛏️|bed|Bett|
🛋️|couch and lamp|Sofa und Lampe|
🪑|chair|Stuhl|
🖼️|framed picture|Bild mit Rahmen|
🛍️|shopping bags|Einkaufstüten|
📦|package|Paket|box
📫|closed mailbox with raised flag|Briefkasten|post mail
✉️|envelope|Umschlag|mail brief email
📧|e-mail|E-Mail|
📝|memo|Notizzettel|note notiz
📁|file folder|Ordner|
📅|calendar|Kalender|date datum
📈|chart increasing|Aufwärtstrend|
📉|chart decreasing|Abwärtstrend|
📊|bar chart|Balkendiagramm|
📋|clipboard|Klemmbrett|
📌|pushpin|Reißzwecke|
📎|paperclip|Büroklammer|
📏|straight ruler|Lineal|
✂️|scissors|Schere|
🗑️|wastebasket|Papierkorb|trash müll
🔒|locked|Geschlossenes Schloss|lock sicher
🔓|unlocked|Offenes Schloss|
🔑|key|Schlüssel|
🗝️|old key|Alter Schlüssel|
📕|closed book|Geschlossenes Buch|
📖|open book|Offenes Buch|book buch lesen
📗|green book|Grünes Buch|
📘|blue book|Blaues Buch|
📙|orange book|Oranges Buch|
📚|books|Bücher|books bücher
📓|notebook|Notizbuch|
📰|newspaper|Zeitung|
🔖|bookmark|Lesezeichen|
🏷️|label|Etikett|tag preis price
✏️|pencil|Bleistift|
🖊️|pen|Kugelschreiber|
🖌️|paintbrush|Pinsel|
🖍️|crayon|Wachsmalstift|
🔍|magnifying glass tilted left|Lupe|search suche
📢|loudspeaker|Lautsprecher|
📣|megaphone|Megafon|
🔔|bell|Glocke|notification benachrichtigung
🪄|magic wand|Zauberstab|magic zauber
🪩|mirror ball|Discokugel|disco
☂️|umbrella|Regenschirm|
🌂|closed umbrella|Geschlossener Regenschirm|
`,
  symbols: `
♥️|heart suit|Herz-Symbol|
♠️|spade suit|Pik|
♦️|diamond suit|Karo|
♣️|club suit|Kreuz|
🃏|joker|Joker|
♻️|recycling symbol|Recycling-Symbol|
✅|check mark button|Haken im grünen Kasten|done erledigt ok
✔️|check mark|Haken|
❌|cross mark|Kreuz|no nein x
➕|plus|Plus|
➖|minus|Minus|
❓|red question mark|Rotes Fragezeichen|
❗|red exclamation mark|Rotes Ausrufezeichen|
‼️|double exclamation mark|Doppeltes Ausrufezeichen|
⚠️|warning|Warnung|achtung
🚫|prohibited|Verboten|no
⛔|no entry|Zutritt verboten|
⬆️|up arrow|Pfeil nach oben|
⬇️|down arrow|Pfeil nach unten|
⬅️|left arrow|Pfeil nach links|
➡️|right arrow|Pfeil nach rechts|
🔄|counterclockwise arrows button|Pfeile gegen den Uhrzeigersinn|refresh
🔁|repeat button|Wiederholen|
▶️|play button|Wiedergabe|
⏸️|pause button|Pause|
🔊|speaker high volume|Lautsprecher laut|
🆗|ok button|OK-Zeichen|
🆕|new button|Neu|new neu
🆓|free button|Gratis|free kostenlos
🆒|cool button|Cool|
🆘|sos button|SOS|
🔝|top arrow|Top-Pfeil|
🔴|red circle|Roter Kreis|
🟠|orange circle|Oranger Kreis|
🟡|yellow circle|Gelber Kreis|
🟢|green circle|Grüner Kreis|
🔵|blue circle|Blauer Kreis|
🟣|purple circle|Lila Kreis|
🟤|brown circle|Brauner Kreis|
⚫|black circle|Schwarzer Kreis|
⚪|white circle|Weißer Kreis|
🟥|red square|Rotes Quadrat|
🟧|orange square|Orangenes Quadrat|
🟨|yellow square|Gelbes Quadrat|
🟩|green square|Grünes Quadrat|
🟦|blue square|Blaues Quadrat|
🟪|purple square|Lila Quadrat|
🔶|large orange diamond|Große orange Raute|
🔷|large blue diamond|Große blaue Raute|
💠|diamond with a dot|Raute mit Punkt|
🏁|chequered flag|Zielflagge|finish ziel
🚩|triangular flag|Dreiecksflagge|
🏳️‍🌈|rainbow flag|Regenbogenflagge|pride
🏴‍☠️|pirate flag|Piratenflagge|
♾️|infinity|Unendlichkeit|
♈|aries|Widder|zodiac sternzeichen
♉|taurus|Stier|zodiac sternzeichen
♊|gemini|Zwillinge|zodiac sternzeichen
♋|cancer|Krebs|zodiac sternzeichen
♌|leo|Löwe|zodiac sternzeichen
♍|virgo|Jungfrau|zodiac sternzeichen
♎|libra|Waage|zodiac sternzeichen
♏|scorpio|Skorpion|zodiac sternzeichen
♐|sagittarius|Schütze|zodiac sternzeichen
♑|capricorn|Steinbock|zodiac sternzeichen
♒|aquarius|Wassermann|zodiac sternzeichen
♓|pisces|Fische|zodiac sternzeichen
☮️|peace symbol|Friedenszeichen|peace frieden
☯️|yin yang|Yin und Yang|
✝️|latin cross|Lateinisches Kreuz|
☪️|star and crescent|Stern und Mondsichel|
✡️|star of david|Davidstern|
🧭|compass|Kompass|
`,
}

export interface EmojiEntry {
  /** The emoji itself */
  e: string
  /** Display names */
  name: { en: string; de: string }
  /** Folded (lower case, no diacritics) searchable text per language, including the keywords */
  en: string
  de: string
}
export interface EmojiCategory { id: string; items: EmojiEntry[] }

/** Lower case and strip diacritics, so "Büro", "buero" and "Buro" meet halfway. */
export const fold = (s: string) => s.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')

export const CATEGORIES: EmojiCategory[] = Object.entries(RAW).map(([id, text]) => ({
  id,
  items: text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [e, en, de, kw = ''] = l.split('|')
      return { e, name: { en, de }, en: fold(`${en} ${kw}`), de: fold(`${de} ${kw}`) }
    }),
}))

/**
 * Search in the names of the current language first, then in the other one as a fallback. Every word of the query has to occur
 * in the text (as a substring); matches where all words start a word of the own language come first.
 */
export function searchEmoji(query: string, lang: string): EmojiEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const own = lang === 'de' ? 'de' : 'en'
  const other = own === 'de' ? 'en' : 'de'
  const matches = (text: string) => words.every((w) => text.includes(w))
  const starts = (text: string) => words.every((w) => (' ' + text).includes(' ' + w))
  const mine: EmojiEntry[] = []
  const rest: EmojiEntry[] = []
  for (const c of CATEGORIES) {
    for (const it of c.items) {
      if (matches(it[own])) mine.push(it)
      else if (matches(it[other])) rest.push(it)
    }
  }
  return [...mine.filter((i) => starts(i[own])), ...mine.filter((i) => !starts(i[own])), ...rest]
}
