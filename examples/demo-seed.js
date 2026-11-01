// Fictional reservations for the demo riad "Dar Demo". No real guest data.
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export function demoSeed(myPhone = '212600000000') {
  return {
    reservations: [
      { id: 'R-1001', guestName: 'Lucía Martín', phone: myPhone, lang: 'es', country: 'ES', checkin: day(3), checkout: day(6), room: 'Double Deluxe', adults: 2, children: 0, channel: 'Booking.com', checkinStatus: 'pending', checkinToken: 'demo-1001' },
      { id: 'R-1002', guestName: 'Thomas Weber', phone: '491700000000', lang: 'de', country: 'DE', checkin: day(3), checkout: day(5), room: 'Double', adults: 2, children: 0, channel: 'Direct', checkinStatus: 'pending', checkinToken: 'demo-1002' },
      { id: 'R-1003', guestName: 'Claire Dubois', phone: '33600000000', lang: 'fr', country: 'FR', checkin: day(0), checkout: day(2), room: 'Familiale', adults: 2, children: 1, channel: 'Expedia', checkinStatus: 'done', checkinToken: 'demo-1003' },
    ],
  };
}

// Extra fictional state so the manager's morning brief has a real day to look at:
// a guest arriving today without online check-in, a dinner tonight, a guest waiting for the
// manager, a water bill due soon and an expense waiting for "OK". Not used by the evaluations.
export function demoDay(seed) {
  const now = new Date().toISOString();
  const hoursAgo = (h) => new Date(Date.now() - h * 36e5).toISOString();
  seed.reservations.push(
    { id: 'R-1004', guestName: 'Giulia Rossi', phone: '393400000000', lang: 'it', country: 'IT', checkin: day(0), checkout: day(3), room: 'Suite Patio', adults: 2, children: 0, channel: 'Airbnb', checkinStatus: 'pending', checkinToken: 'demo-1004' },
    { id: 'R-1005', guestName: 'James Carter', phone: '447700000000', lang: 'en', country: 'GB', checkin: day(1), checkout: day(4), room: 'Double', adults: 2, children: 0, channel: 'Booking.com', checkinStatus: 'done', arrivalTime: '23:30', checkinToken: 'demo-1005' },
  );
  seed.requests = [{ id: 'req_demo1', at: now, status: 'pending', kind: 'dinner', reservation: 'R-1003', phone: '33600000000', date: day(0), time: '20:00', people: 3, dietary: '1 enfant, sans gluten', totalDH: 450 }];
  seed.handoffs = [{ id: 'ho_demo1', at: hoursAgo(9), status: 'open', phone: '491700000000', reason: 'price', summary: 'Thomas asks the price of one extra night (Double)', urgent: false }];
  seed.expenses = [
    { id: 'exp_demo1', at: hoursAgo(30), status: 'approved', source: 'photo', docKind: 'utility_bill', supplier: 'Régie eau & électricité (démo)', total: 509.8, dueDate: day(2), lines: [] },
    { id: 'exp_demo2', at: hoursAgo(1), status: 'draft', source: 'voice', supplier: null, total: 120, category: 'gas', paymentMethod: 'cash', lines: [{ label: '3 × bouteille de gaz', amount: 120 }] },
  ];
  return seed;
}
