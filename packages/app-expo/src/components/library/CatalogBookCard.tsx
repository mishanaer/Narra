import { Text } from "@/components/ui/Typography";
import { useSwipePressGuard } from "@/components/ui/swipe-press-guard";
import { generatedCoverTextTone } from "@/lib/book/cover-text-contrast";
import { useColors } from "@/styles/theme";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Image, View } from "react-native";
import { makeStyles } from "./book-card-styles";
import { BookCoverTypography } from "./book-cover-typography";
import { PerspectiveBook } from "./perspective-book";

interface CatalogBookCardProps {
  title: string;
  author: string;
  coverUri?: string;
  cardWidth: number;
  isImporting: boolean;
  isInLibrary: boolean;
  onPress: () => void;
}

export function CatalogBookCard({
  title,
  author,
  coverUri,
  cardWidth,
  isImporting,
  isInLibrary,
  onPress,
}: CatalogBookCardProps) {
  const colors = useColors();
  const styles = makeStyles(colors, cardWidth);
  const { t } = useTranslation();
  const swipePressGuard = useSwipePressGuard();

  return (
    <PerspectiveBook
      width={cardWidth}
      height={cardWidth * (41 / 28)}
      accessibilityLabel={title}
      accessibilityHint={
        isImporting
          ? t("library.catalogImportInProgressTitle", "Книга уже загружается")
          : isInLibrary
            ? t("notes.openBook", "Открыть книгу")
            : t("library.catalogAdd", "Добавить в библиотеку")
      }
      onPress={() => {
        if (swipePressGuard?.canPress() === false) return;
        onPress();
      }}
      cover={
        <View style={styles.coverCanvas}>
          {coverUri ? (
            <Image source={{ uri: coverUri }} style={styles.coverImage} resizeMode="cover" />
          ) : (
            <View style={styles.fallbackCover} />
          )}
          <BookCoverTypography
            title={title}
            author={author}
            width={cardWidth}
            textTone={coverUri ? generatedCoverTextTone({ title, author }) : "dark"}
          />
          {isImporting ? (
            <View pointerEvents="none" style={styles.downloadingOverlay}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.downloadingOverlayText}>
                {t("library.catalogImporting", "Загружаем…")}
              </Text>
            </View>
          ) : null}
        </View>
      }
    />
  );
}
