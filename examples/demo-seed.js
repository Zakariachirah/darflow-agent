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
