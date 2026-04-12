import { Link, useLocation } from 'react-router';
import styles from '@/styles/app.module.css';

export const GameNav = () => {
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path ? styles.activeGame : '';

  return (
    <div className={styles.gameNav}>
      <Link
        to="/"
        className={`${styles.gameLink} ${isActive('/jackpot')}`}
      >
        Jackpot
      </Link>

      <Link
        to="/coinflip"
        className={`${styles.gameLink} ${styles.disabledLink}`}
      >
        Coinflip
      </Link>

        {/* Poker Coming Soon */}
      <div
        className={`${styles.gameLink} ${styles.disabledLink}`}
        title="Coming Soon"
      >
        Poker
      </div>
    </div>
  );
};
