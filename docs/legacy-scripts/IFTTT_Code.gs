
const chaseRegex = /Prime Visa\: You made a \$(.*) transaction with (.*) on (.*) at (.*) ET\./;
const greenLightRegex = /.* spent \$(.*) at (.*) on (.*) at (.*)/;
const greenLightRequestRegex = /.* requests \$(.*) to .* on (.*) at (.*)/;
const greenLightAllowanceRegex = /\$(.*) allowance transferred to .* on (.*) at (.*)/;
const greenLightReturnMoneyRegex = /Miracle moved \$(.*) from Spend Anywhere to your Wallet. Tap to view details. on (.*) at (.*)/;
const greenLightWithdrawRegex = /Miracle withdrew \$(.*) at (.*) on (.*) at (.*)/;


function _formatDate(date)
{
  return `${date.getMonth()+1}/${date.getDate()}/${date.getFullYear()}`;
}

function _handleChase(sheet, cell, cellRow, cellCol)
{
  let matches = cell.toString().match(chaseRegex);
  if (matches == null || matches.length != 5)
  {
    return false;
  }

  // 420 is DST in the pacific northwest. This is obviously fragile and hacky
  let isDST = new Date().getTimezoneOffset() == 420;

  // Im not sure why but chase sends these in a non ISO compliant eastern time
  const dateString = `${matches[3]} ${matches[4]} ${isDST ? "EDT" : "EST"}`;
  const isDate = !isNaN(Date.parse(dateString));
  const price = `-${matches[1]}`;
  const vendor = matches[2];
  if (isDate && price && vendor) {
    const date = new Date(dateString);

    const guessedCategory = _guessAtCategory(vendor, price);
    sheet.getRange(cellRow, cellCol + 1, 1, 4).setValues([[_formatDate(date), vendor, price, guessedCategory]]);
    return true;
  }
  return false;
}

function _handleGreenlight(sheet, cell, cellRow, cellCol)
{
  let matches = cell.toString().match(greenLightRegex);
  if (matches == null || matches.length != 5)
  {
    return false;
  }

  // 420 is DST in the pacific northwest. This is obviously fragile and hacky
  let isDST = new Date().getTimezoneOffset() == 420;

  const time = matches[4].replace("PM", " PM").replace("AM", " AM");
  const dateString = `${matches[3]} ${time}`;
  const isDate = !isNaN(Date.parse(dateString));
  const price = `-${matches[1]}`;
  const vendor = matches[2];
  if (isDate && price && vendor) {
    const date = new Date(dateString);

    const categoryGuess = "DELETE";
    sheet.getRange(cellRow, cellCol + 1, 1, 4).setValues([[_formatDate(date), vendor, price, categoryGuess]]);
    return true;  
  }
  return false;
}

function _handleGreenlightRequests(sheet, cell, cellRow, cellCol)
{
  let matches = cell.toString().match(greenLightRequestRegex);
  if (matches == null || matches.length != 4)
  {
    return false;
  }

  // 420 is DST in the pacific northwest. This is obviously fragile and hacky
  let isDST = new Date().getTimezoneOffset() == 420;

  const time = matches[3].replace("PM", " PM").replace("AM", " AM");
  const dateString = `${matches[2]} ${time}`;
  const isDate = !isNaN(Date.parse(dateString));
  const price = `-${matches[1]}`;
  const vendor = "GREENLIGHT MONEY REQUEST";

  if (isDate && price && vendor)
  {
    const date = new Date(dateString);

    sheet.getRange(cellRow, cellCol + 1, 1, 4).setValues([[_formatDate(date), vendor, price, "<TODO>"]]);
    return true;
  }
  return false;
}

function _handleGreenlightWithdraw(sheet, cell, cellRow, cellCol)
{
  let matches = cell.toString().match(greenLightWithdrawRegex);
  if (matches == null || matches.length != 5)
  {
    return false;
  }

  Logger.log("Applying Withdraw");

  // 420 is DST in the pacific northwest. This is obviously fragile and hacky
  let isDST = new Date().getTimezoneOffset() == 420;

  const time = matches[4].replace("PM", " PM").replace("AM", " AM");
  const dateString = `${matches[3]} ${time}`;
  const isDate = !isNaN(Date.parse(dateString));
  const price = `-${matches[1]}`;
  const vendor = "GREENLIGHT ATM WITHDRAW";

  if (isDate && price && vendor)
  {
    const date = new Date(dateString);

    sheet.getRange(cellRow, cellCol + 1, 1, 4).setValues([[_formatDate(date), vendor, price, "<TODO>"]]);
    return true;
  }
  return false;
}

function _handleGreenlightAllowance(sheet, cell, cellRow, cellCol)
{
  let matches = cell.toString().match(greenLightAllowanceRegex);
  if (matches == null || matches.length != 4)
  {
    return false;
  }

  // 420 is DST in the pacific northwest. This is obviously fragile and hacky
  let isDST = new Date().getTimezoneOffset() == 420;

  const time = matches[3].replace("PM", " PM").replace("AM", " AM");
  const dateString = `${matches[2]} ${time}`;
  const isDate = !isNaN(Date.parse(dateString));
  const price = `-${matches[1]}`;
  const vendor = "GREENLIGHT ALLOWANCE";

  if (isDate && price && vendor)
  {
    const date = new Date(dateString);

    sheet.getRange(cellRow, cellCol + 1, 1, 4).setValues([[_formatDate(date), vendor, price, "Miracle Spending"]]);
    return true;
  }
  return false;
}

function _handleGreenlightMoneyReturn(sheet, cell, cellRow, cellCol)
{
  let matches = cell.toString().match(greenLightReturnMoneyRegex);
  if (matches == null || matches.length != 4)
  {
    return false;
  }

  // 420 is DST in the pacific northwest. This is obviously fragile and hacky
  let isDST = new Date().getTimezoneOffset() == 420;

  const time = matches[3].replace("PM", " PM").replace("AM", " AM");
  const dateString = `${matches[2]} ${time}`;
  const isDate = !isNaN(Date.parse(dateString));
  const price = `${matches[1]}`;
  const vendor = "GREENLIGHT RETURN";

  if (isDate && price && vendor)
  {
    const date = new Date(dateString);

    sheet.getRange(cellRow, cellCol + 1, 1, 4).setValues([[_formatDate(date), vendor, price, "Miracle Spending"]]);
    return true;
  }
  return false;
}

function convert() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = sheet.getRange("A1:A");
  const priceData = sheet.getRange("D1:D").getValues();
  const values = data.getValues();
  for (const row in values)
  {
    for (const col in values[row])
    {
      const cell = values[row][col];
      if (!cell) {
        continue;
      }

      const cellRow = parseInt(row) + 1;
      const cellCol = parseInt(col) + 1;

      Logger.log("Looking at %s at %d:%d", cell, cellRow, cellCol);

      let success = false;
      success = success ? success : _handleGreenlight(sheet, cell, cellRow, cellCol);
      success = success ? success :  _handleGreenlightRequests(sheet, cell, cellRow, cellCol);
      success = success ? success :  _handleGreenlightAllowance(sheet, cell, cellRow, cellCol);
      success = success ? success :  _handleGreenlightMoneyReturn(sheet, cell, cellRow, cellCol);
      success = success ? success :  _handleGreenlightWithdraw(sheet, cell, cellRow, cellCol);
      success = success ? success :  _handleChase(sheet, cell, cellRow, cellCol);

      if (!success)
      {
        sheet.getRange(cellRow, cellCol + 4, 1, 1).setValue(_guessAtCategory(cell, priceData[row][0].toString()));
      }
    }
  }
}
