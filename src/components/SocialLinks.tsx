import DiscordIcon from '@/assets/discord.png';
import TwitterIcon from '@/assets/twitter.png';
import styles from '@/styles/app.module.css';

export const SocialLinks = () => {
  return (
    <div className={styles.socialLinks}>
      <a
        href="https://discord.gg/PZKvqKGgpr"
        target="_blank"
        rel="noreferrer"
        aria-label="Discord"
      >
        <img src={DiscordIcon} alt="Discord" />
      </a>

      <a
        href="https://twitter.com/YOUR_HANDLE"
        target="_blank"
        rel="noreferrer"
        aria-label="Twitter"
      >
        <img src={TwitterIcon} alt="Twitter" />
      </a>
    </div>
  );
};
