import { Navigate, Route, Router } from "@solidjs/router";
import Shell from "./components/Shell";
import Account from "./routes/Account";
import Activities from "./routes/Activities";
import Body from "./routes/Body";
import Climbing from "./routes/Climbing";
import Cycling from "./routes/Cycling";
import Dashboard from "./routes/Dashboard";
import ExerciseHistory from "./routes/ExerciseHistory";
import Exercises from "./routes/Exercises";
import Feed from "./routes/Feed";
import Heatmap from "./routes/Heatmap";
import History from "./routes/History";
import HistoryDetail from "./routes/HistoryDetail";
import Leaderboard from "./routes/Leaderboard";
import NotFound from "./routes/NotFound";
import Profile from "./routes/Profile";
import RoutineDetail from "./routes/RoutineDetail";
import Routines from "./routes/Routines";
import Setup from "./routes/Setup";
import SocialLayout from "./routes/SocialLayout";
import Workout from "./routes/Workout";

// Vite's BASE_URL always ends with "/", but the router's base must not: a
// trailing slash makes every navigation resolve to "//waveform/...". Stripping
// it leaves "" on the root base, which is exactly the no-base behavior.
const routerBase = import.meta.env.BASE_URL.replace(/\/+$/, "");

export default function App() {
  return (
    <Router root={Shell} base={routerBase}>
      <Route path="/" component={Dashboard} />
      <Route path="/setup" component={Setup} />
      <Route path="/workout" component={Workout} />
      <Route path="/history" component={History} />
      <Route path="/history/:id" component={HistoryDetail} />
      <Route path="/exercises" component={Exercises} />
      <Route path="/exercises/:id" component={ExerciseHistory} />
      <Route path="/routines" component={Routines} />
      <Route path="/routines/new" component={RoutineDetail} />
      <Route path="/routines/:id" component={RoutineDetail} />
      <Route path="/activities" component={Activities} />
      <Route path="/activities/cycling" component={Cycling} />
      <Route path="/activities/climbing" component={Climbing} />
      <Route path="/body" component={Body} />
      <Route component={SocialLayout}>
        <Route path="/social" component={() => <Navigate href="/social/leaderboard" />} />
        <Route path="/social/leaderboard" component={Leaderboard} />
        <Route path="/social/heatmap" component={Heatmap} />
        <Route path="/social/feed" component={Feed} />
      </Route>
      <Route path="/profile" component={Profile} />
      <Route path="/account" component={Account} />
      <Route path="/login" component={() => <Navigate href="/account" />} />
      <Route path="*" component={NotFound} />
    </Router>
  );
}
