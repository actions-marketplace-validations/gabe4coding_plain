// Test data for examples/mobile/ios-calendar.yaml, computed per run so the spec works on any day:
// - the 15th of next month: the date picker opens on the current month, so the spec always taps
//   "Next Month" once, then that day ("Thursday, 15 October", as the iOS picker names its buttons);
// - a title unique to this run, so the search finds this run's event and not one left by an earlier run.
// Names follow an English (UK) simulator locale.
export function setup() {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth() + 1, 15);
  const weekday = day.toLocaleDateString('en-GB', { weekday: 'long' });
  const month = day.toLocaleDateString('en-GB', { month: 'long' });
  return {
    title: `Weekly planning ${now.getTime().toString(36).slice(-5)}`,
    day: `${weekday}, 15 ${month}`, // the picker's day button
    date: `15 ${month} ${day.getFullYear()}`, // for the claims
  };
}
