function historicalBudget(startingDates, orderedOldBudgets, currentBudgets) {
  var budgetInfo = {}
  
  var startDateMap = {}
  
  // Create a map of budget name to start date
  for (var rowIndex in startingDates) {
    var row = startingDates[rowIndex];
    var category = row[0];
    var startDate = row[2];
    if (!category) {
      continue;
    }
    startDateMap[category] = new Date(startDate)
  }
  
  var tempOutput = []
  
  // Process each row in budget history by using each budget's start date
  // old budget should be `Category, Old Budget, Month Stopped Using`
  // We add the historical budget to our total budget for the category
  // by multiplying it by the months between the last known date and this
  // historical budget end date. After processing all the historical budgets,
  // we should be left with the remaining months taken up by the current budgets
  for (var rowIndex in orderedOldBudgets)  {
    var row = orderedOldBudgets[rowIndex];
    var category = row[0];
    var oldBudget = row[1];
    var monthStoppedUsing = row[2];
    
    // handle empty rows
    if (!category || !monthStoppedUsing) {
      continue;
    }
    
    var item = getOrCreateBudgetInfo(budgetInfo, startDateMap, category);
    
    var budgetStopDate = new Date(monthStoppedUsing);
    var monthsBetween = monthDiff(item["lastDate"], budgetStopDate)
    
    if (monthsBetween > 0) {
      item["totalBudget"] += monthsBetween * oldBudget;
      item["months"] += monthsBetween;
      item["lastDate"] = budgetStopDate;  
    }
    
    tempOutput.push([category, monthsBetween, oldBudget, item["totalBudget"]])
  }
  
  // Process current budgets
  // After adding all the historical budgets to the running tally of a category,
  // we fill in the rest of the months up to the current month with the current
  // budget
  for (var rowIndex in currentBudgets) {
    var row = currentBudgets[rowIndex];
    var category = row[0];
    var budget = row[1];
    
    // handle empty rows
    if (!category) {
      continue;
    }
    
    var item = getOrCreateBudgetInfo(budgetInfo, startDateMap, category);
    
    var monthsBetween = monthDiff(item["lastDate"], new Date()) + 1
    
    if (monthsBetween > 0) {
      item["months"] += monthsBetween;
      item["totalBudget"] += monthsBetween * budget;
    }
    
    tempOutput.push([category, monthsBetween, budget, item["totalBudget"]])
    
  }
  
  var output = [["Category", "Months", "Total"]];
  for (var cat in budgetInfo) {
    var catInfo = budgetInfo[cat];
    output.push([cat, catInfo["months"], catInfo["totalBudget"].toFixed(2)])
  }
  return output;
}

function getOrCreateBudgetInfo(budgetInfo, startDateMap, category) {
  var item;
  if (category in budgetInfo) {
    item = budgetInfo[category];
  }
  else {
    // We create the item with the starting date so we can calculate
    // historical budgets from that date
    item = {
      "lastDate": startDateMap[category],
      "months": 0,
      "totalBudget": 0
    }
  }
  budgetInfo[category] = item;
  
  return item;
}

function monthDiff(d1, d2) {
    var months;
    months = (d2.getFullYear() - d1.getFullYear()) * 12;
    months -= d1.getMonth();
    months += d2.getMonth();
    return months <= 0 ? 0 : months;
}
