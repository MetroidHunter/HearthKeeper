function _guessAtCategory(vendor, price)
{
  const toCheck = vendor.toLowerCase();
  switch (true)
  {
    case toCheck.includes("shell oil"):
    case toCheck.includes("76 -"):
    case toCheck.includes("safeway fuel"):
    case toCheck.includes("chevron"):
    case toCheck.includes("shree truck"):
    case toCheck.includes("texaco"):
    case toCheck.includes("arco"):
    case toCheck.includes("sunoco"):
    case toCheck.includes("exxon"):
    case toCheck.includes("shrees gas"):
      return "Gas";
    case toCheck.includes("amazon prime"):
      return "Amazon Prime";
    case toCheck.includes("mud bay"):
    case toCheck.includes("ptz insurance agency"):
    case toCheck.includes("all the best pet"):
    case toCheck.includes("veterinary"):
    case toCheck.includes("petco"):
    case toCheck.includes("petsmart"):
      return "Pets";
    case toCheck.includes("mb auto finance"):
      return "Car Payment";
    case toCheck.includes("uncle ike"):
      return "Cannabis";
    case toCheck.includes("seattle city light"):
    case toCheck.includes("seattle pse gas"):
    case toCheck.includes("soch management"):
      return "Water/Sewer/Energy";
    case toCheck.includes("inner roots"):
      return "Therapy";
    case toCheck.includes("lucidchart"):
      return "Lucidcharts";
    case toCheck.includes("lastpass"):
      return "LastPass";
    case toCheck.includes("venmo") && toCheck.includes("brys") && price == '-150':
    case toCheck.includes("ellis"):
      return "Laser Hair";
    case toCheck.includes("altar of nails"):
    case toCheck.includes("zelle to vy"):
    case toCheck.includes("rias nail bar"):
      return "Manicure";
    case toCheck.includes("hulu"):
      return "Hulu";
    case toCheck.includes("qfc"):
    case toCheck.includes("safeway #"):
    case toCheck.includes("safeway"):
    case toCheck.includes("m2m"):
    case toCheck.includes("amazonstores"):
    case toCheck.includes("uwajimaya"):
    case toCheck.includes("instacart"):
    case toCheck.includes("dashmart"):
    case toCheck.includes("wholefds"):
    case toCheck.includes("kroger"):
    case toCheck.includes("pcc -"):
    case toCheck.includes("7-eleven"):
    case toCheck.includes("amazon fresh"):
    case toCheck.includes("fred meyer"):
    case toCheck.includes("fred-meyer"):
      return "Groceries";
    case toCheck.includes("bellevue medical"):
    case toCheck.includes("nguyen pharmacy"):
    case toCheck.includes("walgreens"):
    case toCheck.includes("bartell drug"):
    case toCheck.includes("quest diagnostics"):
      return "Doctor";
    case toCheck.includes("patreon"):
      return "Patreon Subs";
    case toCheck.includes("google *cloud"):
    case toCheck.includes("google storage"):
    case toCheck.includes("google sto"):
    case toCheck.includes("gp payments"):
    case toCheck.includes("google one"):
    case toCheck.includes("google google"):
      return "Google Drive";
    case toCheck.includes("wizards of coast"):
      return "DnD Service";
    case toCheck.includes("google *bytedance"):
      return "Capcut";
    case toCheck.includes("dashpass"):
      return "Dashpass";
    case toCheck.includes("dropout"):
      return "Dropout TV";
    case toCheck.includes("seatimes"):
      return "Seattle Times";
    case toCheck.includes("spotify"):
      return "Spotify";
    case toCheck.includes("ny times nyt"):
    case toCheck.includes("nytimes"):
      return "New York Times";
    case toCheck.includes("disney plus"):
    case toCheck.includes("disneyplus"):
      return "Disney Plus";
    case toCheck.includes("fodzyme"):
      return "Fodzyme";
    case toCheck.includes("state farm ro 27") && toCheck.includes("sfpp") && toCheck.includes("19"):
      return "Miracle Life Insurance";
    case toCheck.includes("state farm ro 27") && toCheck.includes("sfpp") && toCheck.includes("15"):
    case toCheck.includes("state farm ro 27") && toCheck.includes("cpc-client") && toCheck.includes("15"):
      return "Car Insurance";
    case toCheck.includes("trinet"):
    case toCheck.includes("sequoia"):
      return "Salary";
    case toCheck.includes("gps renting"):
      return "Rent";
    case toCheck.includes("unitedwholesale"):
      return "Mortgage";
    case toCheck.includes("gregory marion"):
    case toCheck.includes("mjgregory"):
      return "Family Support";
    case toCheck.includes("planned parenthood"):
    case toCheck.includes("international rescue comm"):
    case toCheck.includes("aclu"):
    case toCheck.includes("irc donation"):
      return "Political Action";
    case toCheck.includes("wave internet"):
    case toCheck.includes("astound pwrd by wave"):
    case toCheck.includes("quantum"):
      return "Internet";
    case toCheck.includes("crunchyroll"):
      return "Crunchy Roll";
    case toCheck.includes("tokyotreat"):
      return "Online Goods Boxes";
    case toCheck.includes("southgate"):
      return "Southgate";
    case toCheck.includes("tmobile"):
    case toCheck.includes("t-mobile"):
    case toCheck.includes("samsung*premium"):
      return "Phone";
    case toCheck.includes("orca"):
    case toCheck.includes("goodtogo"):
    case toCheck.includes("laz parking"):
    case toCheck.includes("metropolis parking"):
    case toCheck.includes("sdot paybyphone parking"):
    case toCheck.includes("paybyphone diamond"):
    case toCheck.includes("diamond parking"):
    case toCheck.includes("lime ride"):
    case toCheck.includes("lyft"):
    case toCheck.includes("parkwhiz"):
    case toCheck.includes("bird app"):
    case toCheck.includes("uw pay by phone"):
    case toCheck.includes("u park sy"):
      return "Bus";
    case toCheck.includes("twitch"):
    case toCheck.includes("feebeechanc"):
      return "Twitch Subs";
    case toCheck.includes("youtubepremi"):
      return "Youtube Premium";
    case toCheck.includes("nintendo cd"):
      return "Switch Online";
    case toCheck.includes("netflix"):
      return "Netflix";
    case toCheck.includes("quip nyc"):
      return "Goods Subscription";
    case toCheck.includes("venmo") && price == '-300':
      return "Schouvi";
    case toCheck.includes("discord"):
      return "Discord Nitro";
    case toCheck.includes("greenlight app"):
    case toCheck.includes("chase card serv"):
    case toCheck.includes("payment thank you - web"):
    case toCheck.includes("chase credit crd"):
    case toCheck.includes("payment thank you-mobile"):
      return "DELETE";
    case toCheck.includes("monthly service fee"):
      return "Fees and Taxes";
    case toCheck.includes("dept education"):
      return "Miracle Student Loan";
    case toCheck.includes("recurring transfer to thomas"):
      return "Miracle Savings Transfer";
    case toCheck.includes("lowes"):
    case toCheck.includes("instantink"):
      return "Home Improvement";
    case toCheck.includes("tovala"):
      return "MealKits";
    case toCheck.includes("moises"):
      return "Moises";
    case toCheck.includes("reprotech"):
      return "Reproductive";
    case toCheck.includes("american air"):
    case toCheck.includes("delta air"):
    case toCheck.includes("alaska air"):
      return "Trip Planning";
    case toCheck.includes("hidive svc dice"):
      return "HiDive";
    case toCheck.includes("wildrose"):
    case toCheck.includes("unicorn/narwhal"):
    case toCheck.includes("queer bar"):
    case toCheck.includes("the crocodile"):
    case toCheck.includes("cuff complex"):
    case toCheck.includes("lumberyard"):
      return "Amusement";
    case toCheck.includes("salondeantony"):
    case toCheck.includes("pixiv"):
    case toCheck.includes("game informer"):
      return "Brys Spending";
    case toCheck.includes("webtoons"):
    case toCheck.includes("webtoon"):
      return "Webtoons";
    case toCheck.includes("blizzard *us"):
      return "Game Subs";
    case toCheck.includes("theatre puget sound"):
    case toCheck.includes("ocean in space"):
      return "Magical Melody";
    case toCheck.includes("wanderersmailservices"):
      return "POBox";
    case toCheck.includes("hostgator"):
      return "Site Hosting";
    case toCheck.includes("wa vehicle licensing"):
      return "Car Taxes";
    case toCheck.includes("capcut"):
      return "Capcut";
    case toCheck.includes("canva pty"):
    case toCheck.includes("canva"):
      return "Canva";
    case toCheck.includes("sephora"):
    case toCheck.includes("ulta"):
      return "Makeup";
    case toCheck.includes("splice.com"):
      return "Splice";
    case toCheck.includes("buddha brudda"):
    case toCheck.includes("chipotle mex"):
    case toCheck.includes("chipotle"):
    case toCheck.includes("shooby doo cater"):
    case toCheck.includes("premier meat pies"):
    case toCheck.includes("doordash"):
    case toCheck.includes("mcdonald's"):
    case toCheck.includes("mcdonalds"):
    case toCheck.includes("armistice coffee"):
    case toCheck.includes("tous les jours"):
    case toCheck.includes("haidilao"):
    case toCheck.includes("boiling point"):
    case toCheck.includes("hong kong bistro"):
    case toCheck.includes("mt. joy"):
    case toCheck.includes("kajiken"):
    case toCheck.includes("lune cafe"):
    case toCheck.includes("ana's cafe"):
    case toCheck.includes("anas cafe"):
    case toCheck.includes("beanfish"):
    case toCheck.includes("domino's"):
    case toCheck.includes("jimmy johns"):
    case toCheck.includes("hawk dogs"):
    case toCheck.includes("cheeky cafe"):
    case toCheck.includes("betsutenjin"):
    case toCheck.includes("toulouse petit"):
    case toCheck.includes("sharetea"):
    case toCheck.includes("dont yell at me"):
    case toCheck.includes("sugar hill"):
    case toCheck.includes("perihelion"):
    case toCheck.includes("one bite cafe"):
    case toCheck.includes("taqueria"):
    case toCheck.includes("din tai fung"):
    case toCheck.includes("just poke"):
    case toCheck.includes("voodoo doughnut"):
    case toCheck.includes("subway"):
    case toCheck.includes("gangnam seattle"):
    case toCheck.includes("shake shack"):
    case toCheck.includes("honey court"):
    case toCheck.includes("katsu burger"):
    case toCheck.includes("queen mary tea"):
    case toCheck.includes("pagliacci"):
    case toCheck.includes("kkokio"):
    case toCheck.includes("nanas green tea"):
    case toCheck.includes("bellwether"):
    case toCheck.includes("big marios pizza"):
    case toCheck.includes("molly moon's"):
    case toCheck.includes("lil woodys"):
    case toCheck.includes("lady yum"):
    case toCheck.includes("puffypandy"):
    case toCheck.includes("proletariat pizza"):
    case toCheck.includes("jardin tea"):
    case toCheck.includes("starbucks"):
    case toCheck.includes("antojitos jalisco"):
    case toCheck.includes("mendocino farms"):
    case toCheck.includes("cold stone creamery"):
    case toCheck.includes("jamba juice"):
    case toCheck.includes("popeyes"):
    case toCheck.includes("pioneer tacos"):
    case toCheck.includes("comebuytea"):
    case toCheck.includes("wendys"):
    case toCheck.includes("meetea"):
    case toCheck.includes("momiji"):
    case toCheck.includes("sweetgreen"):
    case toCheck.includes("85c bakery"):
    case toCheck.includes("carmelos"):
    case toCheck.includes("panda yogurt"):
    case toCheck.includes("starbuck"):
    case toCheck.includes("banh mi"):
    case toCheck.includes("poquitos"):
    case toCheck.includes("bobae"):
    case toCheck.includes("ba bar"):
    case toCheck.includes("drip tea"):
    case toCheck.includes("la cuadra"):
    case toCheck.includes("hokkaido ramen"):
    case toCheck.includes("bobalust tea house"):
    case toCheck.includes("lil reds takeout"):
    case toCheck.includes("13 coins"):
    case toCheck.includes("hood famous cafe"):
    case toCheck.includes("ivars fishbar"):
    case toCheck.includes("milkdrunk"):
    case toCheck.includes("dilettante mocha"):
      return "Eating Out";
    case toCheck.includes("maison de v"):
    case toCheck.includes("premier vocal entertainment"):
    case toCheck.includes("the great surpri"):
    case toCheck.includes("haus of horn"):
      return "Gig Income";
    default:
      return null;
  }
}