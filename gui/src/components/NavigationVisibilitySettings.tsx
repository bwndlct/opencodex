import { useT, type TKey } from "../i18n";
import {
  OPTIONAL_NAV_PAGES,
  type NavigationVisibility,
  type OptionalNavPage,
} from "../navigation-preferences";
import { Switch } from "../ui";

const PAGE_LABELS: Record<OptionalNavPage, TKey> = {
  combos: "nav.combos",
  logs: "nav.logs",
  debug: "nav.debug",
  api: "nav.api",
  claude: "nav.claude",
};

export default function NavigationVisibilitySettings({
  visibility,
  onChange,
}: {
  visibility: NavigationVisibility;
  onChange: (page: OptionalNavPage, visible: boolean) => void;
}) {
  const t = useT();
  return (
    <section className="settings-section" aria-labelledby="settings-navigation-title">
      <div className="settings-section-heading">
        <div>
          <h2 id="settings-navigation-title">{t("settings.navigation.title")}</h2>
          <p className="muted">{t("settings.navigation.subtitle")}</p>
        </div>
      </div>
      <div className="settings-rows">
        {OPTIONAL_NAV_PAGES.map(page => {
          const label = t(PAGE_LABELS[page]);
          return (
            <div className="settings-row" key={page}>
              <strong>{label}</strong>
              <Switch
                on={visibility[page]}
                onClick={() => onChange(page, !visibility[page])}
                label={t("settings.navigation.show", { item: label })}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
