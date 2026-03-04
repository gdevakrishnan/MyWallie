/**
 * dateUtils.js
 * All date filtering utilities isolated here per the spec.
 * Uses dayjs with plugins.
 */
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";

dayjs.extend(isBetween);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export const dateUtils = {
  filterByPeriod(transactions, period, customFrom, customTo) {
    const today = dayjs();
    return transactions.filter(t => {
      const d = dayjs(t.Date);
      switch (period) {
        case "daily":   return d.isSame(today, "day");
        case "weekly":  return d.isSame(today, "week");
        case "monthly": return d.isSame(today, "month");
        case "yearly":  return d.isSame(today, "year");
        case "custom":
          if (!customFrom || !customTo) return true;
          return (
            d.isSameOrAfter(dayjs(customFrom), "day") &&
            d.isSameOrBefore(dayjs(customTo), "day")
          );
        default: return true;
      }
    });
  },

  formatDisplay(date) {
    return dayjs(date).format("DD MMM YYYY");
  },

  today() {
    return dayjs().format("YYYY-MM-DD");
  },
};
