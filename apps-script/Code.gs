/**
 * Google Apps Script client for the CS price service.
 *
 * Google's servers cannot reach Steam directly, but they can reach your own
 * server, which keeps the price cache. Purchase and sale data stays in this
 * spreadsheet; the script only fills in current market values.
 *
 * Setup:
 *   1. Extensions > Apps Script, paste this file.
 *   2. Run setup() once and enter the base URL and the admin key. They are
 *      stored in Script Properties, not in the sheet, so nobody with view
 *      access to the spreadsheet can read the key.
 *   3. Reload the spreadsheet and use the "CS Prices" menu.
 */

// --- Sheet layout --------------------------------------------------------
// Sheet holding your purchase log, one row per item.
var LOG_SHEET_NAME = "Käufe";
// First data row, i.e. the row below the headers.
var LOG_FIRST_ROW = 2;
// Column with the exact Steam market hash name, for example "AK-47 | Redline (Field-Tested)".
var LOG_NAME_COLUMN = "A";
// Column that receives the current gross market price per unit.
var LOG_PRICE_COLUMN = "F";
// Column that receives the payout after Steam's 15% cut.
var LOG_NET_COLUMN = "G";

// Sheet that receives the full current inventory dump. Created if missing.
var INVENTORY_SHEET_NAME = "Bestand";
// Your own SteamID64.
var MY_STEAM_ID = "76561190000000000";

// --- Menu ----------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("CS Prices")
    .addItem("Preise im Kauf-Log aktualisieren", "refreshLogPrices")
    .addItem("Inventar neu einlesen", "refreshInventorySheet")
    .addSeparator()
    .addItem("Verbindung einrichten", "setup")
    .addItem("Verbindung testen", "testConnection")
    .addToUi();
}

/** Stores the server URL and admin key in Script Properties. */
function setup() {
  var ui = SpreadsheetApp.getUi();
  var baseResponse = ui.prompt(
    "Server-URL",
    "Basis-URL ohne abschliessenden Slash, z. B. https://cs.example.de/api",
    ui.ButtonSet.OK_CANCEL,
  );
  if (baseResponse.getSelectedButton() !== ui.Button.OK) return;

  var keyResponse = ui.prompt(
    "Admin-Key",
    "Der ADMIN_KEY aus der .env des Servers",
    ui.ButtonSet.OK_CANCEL,
  );
  if (keyResponse.getSelectedButton() !== ui.Button.OK) return;

  PropertiesService.getScriptProperties().setProperties({
    API_BASE: baseResponse.getResponseText().trim().replace(/\/+$/, ""),
    API_KEY: keyResponse.getResponseText().trim(),
  });
  ui.alert("Gespeichert.");
}

// --- HTTP helpers --------------------------------------------------------

function getConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var base = properties.getProperty("API_BASE");
  var key = properties.getProperty("API_KEY");
  if (!base || !key) {
    throw new Error(
      'Verbindung nicht eingerichtet. Bitte zuerst "Verbindung einrichten" ausführen.',
    );
  }
  return { base: base, key: key };
}

/** Performs an authenticated request and returns the parsed JSON body. */
function apiRequest_(path, method, payload) {
  var config = getConfig_();
  var options = {
    method: method || "get",
    muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + config.key },
    contentType: "application/json",
  };
  if (payload) options.payload = JSON.stringify(payload);

  var response = UrlFetchApp.fetch(config.base + path, options);
  var code = response.getResponseCode();
  var text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error("Server antwortete mit " + code + ": " + text);
  }
  return JSON.parse(text);
}

function testConnection() {
  var status = apiRequest_("/admin/status", "get");
  SpreadsheetApp.getUi().alert(
    "Verbindung OK\n\n" +
      "Preise im Cache: " +
      status.priceItems +
      "\n" +
      "Letzter Refresh: " +
      (status.lastPriceRefresh || "nie") +
      "\n" +
      "Währung: " +
      status.currency,
  );
}

// --- Actions -------------------------------------------------------------

/**
 * Reads every item name from the purchase log, asks the server for current
 * prices in batches of 500 and writes them back. Rows whose name cannot be
 * priced are left empty rather than zeroed, so a lookup failure is visible.
 */
function refreshLogPrices() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(LOG_SHEET_NAME);
  if (!sheet)
    throw new Error('Tabellenblatt "' + LOG_SHEET_NAME + '" nicht gefunden.');

  var lastRow = sheet.getLastRow();
  if (lastRow < LOG_FIRST_ROW) return;

  var rowCount = lastRow - LOG_FIRST_ROW + 1;
  var names = sheet
    .getRange(LOG_NAME_COLUMN + LOG_FIRST_ROW + ":" + LOG_NAME_COLUMN + lastRow)
    .getValues()
    .map(function (row) {
      return String(row[0] || "").trim();
    });

  var unique = [];
  var seen = {};
  names.forEach(function (name) {
    if (name && !seen[name]) {
      seen[name] = true;
      unique.push(name);
    }
  });

  var priceMap = {};
  var missing = [];
  for (var i = 0; i < unique.length; i += 500) {
    var response = apiRequest_("/prices/lookup", "post", {
      names: unique.slice(i, i + 500),
    });
    Object.keys(response.prices).forEach(function (name) {
      priceMap[name] = response.prices[name];
    });
    missing = missing.concat(response.missing || []);
  }

  var priceColumn = [];
  var netColumn = [];
  for (var row = 0; row < rowCount; row++) {
    var entry = priceMap[names[row]];
    priceColumn.push([entry ? entry.price : ""]);
    netColumn.push([entry ? entry.netAfterFee : ""]);
  }

  sheet
    .getRange(
      LOG_PRICE_COLUMN + LOG_FIRST_ROW + ":" + LOG_PRICE_COLUMN + lastRow,
    )
    .setValues(priceColumn);
  sheet
    .getRange(LOG_NET_COLUMN + LOG_FIRST_ROW + ":" + LOG_NET_COLUMN + lastRow)
    .setValues(netColumn);

  SpreadsheetApp.getActive().toast(
    unique.length -
      missing.length +
      " von " +
      unique.length +
      " Namen bepreist.",
    "CS Prices",
    8,
  );
}

/**
 * Replaces the inventory sheet with the current holdings and their values.
 * Everything below the header is rewritten, so keep manual notes elsewhere.
 */
function refreshInventorySheet() {
  var result = apiRequest_("/portfolio/" + MY_STEAM_ID + "?refresh=1", "get");

  var spreadsheet = SpreadsheetApp.getActive();
  var sheet =
    spreadsheet.getSheetByName(INVENTORY_SHEET_NAME) ||
    spreadsheet.insertSheet(INVENTORY_SHEET_NAME);
  sheet.clearContents();

  var header = [
    "Item",
    "Anzahl",
    "Preis/Stk",
    "Gesamt",
    "Nach Gebühr",
    "Handelbar",
    "Quelle",
    "Preis vom",
  ];
  var rows = result.items.map(function (item) {
    return [
      item.name,
      item.quantity,
      item.unitPrice,
      item.totalPrice,
      item.netAfterFee,
      item.marketable,
      item.priceSource,
      item.priceUpdatedAt ? new Date(item.priceUpdatedAt) : "",
    ];
  });

  sheet
    .getRange(1, 1, 1, header.length)
    .setValues([header])
    .setFontWeight("bold");
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  }

  // Summary block to the right of the table, referenced by the P&L formulas.
  sheet.getRange("J1:K5").setValues([
    ["Stand", new Date()],
    ["Positionen", result.uniqueItems],
    ["Items gesamt", result.totalItems],
    ["Marktwert", result.totalMarketValue],
    ["Nach Gebühr", result.totalNetAfterFee],
  ]);

  sheet.autoResizeColumns(1, header.length);
  spreadsheet.toast(
    "Inventar aktualisiert: " + result.totalMarketValue + " " + result.currency,
    "CS Prices",
    8,
  );
}

/**
 * Optional: install a daily trigger so the sheet stays current without manual
 * clicks. Run once, then check Triggers in the Apps Script editor.
 */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "refreshLogPrices")
      ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("refreshLogPrices")
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
}
