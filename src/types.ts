export type Preferences = {
  pace: "relaxed" | "balanced" | "packed";
  interests: string[];
  travelers: number;
  budget: number | null;
  transport: "auto" | "walking" | "driving" | "transit";
};
export type ContentSource = { title: string; url: string; updatedAt: string };
export type BookingChannel = {
  kind: "website" | "miniprogram" | "official_account";
  name: string;
  url: string | null;
  instructions: string;
  source: ContentSource;
};
export type PlaceContentStatus = "loading" | "ready" | "empty" | "error" | "local";
export type PlaceContentMetadata = {
  status: PlaceContentStatus;
  checkedAt?: string;
  expiresAt: number | null;
  message?: string;
  automaticRetries?: number;
  manualRetryRequired?: boolean;
};
export type PlaceContentResult = PlaceContentMetadata & { place: Place };
export type Place = {
  id: string;
  name: string;
  city: string;
  province?: string;
  district?: string;
  country: string;
  address: string;
  location: { lng: number; lat: number; coordSystem: "GCJ-02" | "WGS84" };
  overview: string;
  overviewSource?: ContentSource | null;
  bookingChannels?: BookingChannel[];
  aiRating?: number | null;
  category: string;
  photo: string;
  photos?: string[];
  suggestedMinutes: number;
  openingHours: string | null;
  price: number | null;
  currency: string;
  source: { provider: string; url: string; updatedAt: string; note: string };
};
export type Item = {
  id: string;
  kind: "place" | "break";
  placeId: string | null;
  title: string;
  arrival: string;
  durationMinutes: number;
  notes: string;
};
export type Day = {
  index: number;
  date: string | null;
  title: string;
  transport?: "walking" | "driving" | "transit";
  items: Item[];
};
export type Trip = {
  id: string;
  title: string;
  city: string;
  summary: string;
  preferences: Preferences;
  createdAt: string;
  updatedAt: string;
  days: Day[];
  favorite?: boolean;
  status?: string;
  cover?: Place;
  savedVisible?: boolean;
  footprintVisible?: boolean;
};
export type User = {
  id: string;
  username: string | null;
  nickname: string;
  preferences: Preferences;
};
export type Message = { role: "user" | "assistant"; content: string };
export type Leg = {
  from: string;
  to: string;
  itemFrom: string;
  itemTo: string;
  status: string;
  mode: string;
  minutes?: number;
  distance?: number;
  polyline?: number[][];
  segments?: RouteSegment[];
  message?: string;
};
export type RouteSegment = {
  mode: string;
  name: string;
  city?: string;
  fullName?: string;
  lineId?: string;
  color?: string;
  departureStop?: string;
  arrivalStop?: string;
  stops?: { name: string; location: number[] }[];
  distance?: number;
  minutes?: number;
  polyline: number[][];
};
export type Audit = {
  checkedAt: string;
  days: { index: number; legs: Leg[]; warnings: string[] }[];
  quality?: {
    issues: {
      code: string;
      severity: "warning" | "error";
      message: string;
      day?: number;
    }[];
  };
};
export type TripBundle = { trip: Trip; places: Place[]; placeContents?: Record<string, PlaceContentMetadata>; audit?: Audit | null };
export type TripFile = {
  format: "roamly.itinerary";
  version: "1.0";
  exportedAt: string;
  itinerary: Trip;
  places: Place[];
  audit?: Audit | null;
};
export type Conversation = {
  id: string;
  trip_id: string | null;
  messages: Message[];
};
