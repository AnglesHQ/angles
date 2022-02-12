const groupingUtils = {};

groupingUtils.getNestedProperty = (obj, key) => {
  const properties = key.split('.');
  for (let i = 0; i < properties.length; i += 1) {
    // eslint-disable-next-line no-prototype-builtins
    if (!obj || !obj.hasOwnProperty(properties[i])) {
      return undefined;
    }
    // eslint-disable-next-line no-param-reassign
    obj = obj[properties[i]];
  }
  return obj;
};

groupingUtils.groupExecutionsByPeriod = (fromDate, toDate, period,
  objectsToGroup, dateFieldName) => {
  let processingDate = new Date(fromDate);
  let periodInteger = 1;

  // eslint-disable-next-line no-restricted-globals
  if (!isNaN(period)) {
    periodInteger = parseInt(period, 10);
  } else if (period === 'day') {
    periodInteger = 1;
  } else if (period === 'week') {
    periodInteger = 7;
  } else if (period === 'fortnight') {
    periodInteger = 14;
  }

  let periodCounter = 0;
  const periods = [];
  while (processingDate < toDate) {
    // create a new time period object
    const timePeriod = {};
    periodCounter += 1;
    timePeriod.id = periodCounter;
    timePeriod.items = [];

    if (period === 'month') {
      timePeriod.start = new Date(processingDate.getFullYear(), processingDate.getMonth(), 1);
      timePeriod.end = new Date(processingDate.getFullYear(), processingDate.getMonth() + 1, 0);
      processingDate = new Date(timePeriod.end.valueOf());
      processingDate.setDate(processingDate.getDate() + 1);
    } else if (period === 'year') {
      timePeriod.start = new Date(processingDate.getFullYear(), 0, 1);
      timePeriod.end = new Date(processingDate.getFullYear(), 12, 0);
      processingDate = new Date(timePeriod.end.valueOf());
      processingDate.setDate(processingDate.getDate() + 1);
    } else {
      // set start date for period
      timePeriod.start = new Date(processingDate);

      // set end date for period
      timePeriod.end = new Date(timePeriod.start.valueOf());
      timePeriod.end.setDate(timePeriod.start.getDate() + periodInteger - 1);
      if (timePeriod.end > toDate) { timePeriod.end.setDate(toDate.getDate()); }

      // set new processing date
      processingDate.setDate(processingDate.getDate() + periodInteger);
    }

    // change time on start and end date
    timePeriod.start.setHours(0, 0 - timePeriod.start.getTimezoneOffset(), 0);
    timePeriod.end.setHours(23, 59 - timePeriod.start.getTimezoneOffset(), 59);

    // store period
    periods.push(timePeriod);
  }
  objectsToGroup.forEach((object) => {
    const objectDate = new Date(groupingUtils.getNestedProperty(object, dateFieldName));
    periods.forEach((currentPeriod) => {
      if (objectDate > currentPeriod.start && objectDate < currentPeriod.end) {
        currentPeriod.items.push(object);
      }
    });
  });
  return periods;
};

module.exports = groupingUtils;
