import commercial from "../assets/icons/commercial.svg";
import business from "../assets/icons/business.svg";
import military from "../assets/icons/military.svg";
import general from "../assets/icons/general.svg";
import cargo from "../assets/icons/cargo.svg";
import tanker from "../assets/icons/tanker.svg";
import passenger from "../assets/icons/passenger.svg";
import military_vessel from "../assets/icons/military_vessel.svg";
import fishing from "../assets/icons/fishing.svg";
import sailing from "../assets/icons/sailing.svg";
import pleasure from "../assets/icons/pleasure.svg";
import tug_work from "../assets/icons/tug_work.svg";
import service from "../assets/icons/service.svg";
import other from "../assets/icons/other.svg";

export const ICON_URLS: Record<string, string> = {
  commercial,
  business,
  military,
  general,
  cargo,
  tanker,
  passenger,
  military_vessel,
  fishing,
  sailing,
  pleasure,
  tug_work,
  service,
  other,
};

export const ICON_NAMES: string[] = Object.keys(ICON_URLS);
