import { Navigate, Route, Router } from "@solidjs/router";
import Shell from "./components/Shell";
import Activities from "./routes/Activities";
import Body from "./routes/Body";
import Climbing from "./routes/Climbing";
import Cycling from "./routes/Cycling";
import Dashboard from "./routes/Dashboard";
import Exercises from "./routes/Exercises";
import Feed from "./routes/Feed";
import Heatmap from "./routes/Heatmap";
import History from "./routes/History";
import Leaderboard from "./routes/Leaderboard";
import Login from "./routes/Login";
import NotFound from "./routes/NotFound";
import Profile from "./routes/Profile";
import SocialLayout from "./routes/SocialLayout";
import Workout from "./routes/Workout";

export default function App() {
  return (
    <Router root={Shell}>
      <Route path="/" component={Dashboard} />
      <Route path="/workout" component={Workout} />
      <Route path="/history" component={History} />
      <Route path="/exercises" component={Exercises} />
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
      <Route path="/login" component={Login} />
      <Route path="*" component={NotFound} />
    </Router>
  );
}
